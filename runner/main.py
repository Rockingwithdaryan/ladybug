"""Executes untrusted code against test cases, or traces one call: `python3 main.py run|trace <job.json>`.

Prints the result as JSON on stdout. Exits with 2 for an invalid job and 1 if the runner itself failed.

Each job runs in its own Vercel Sandbox microVM (see server/sandbox.ts): no network, no secrets, thrown away
afterwards, so nothing a submission leaves behind can reach the next one. The limits here (rlimits, timeout,
empty env, temp dir) are defence in depth within it.
"""
import json
import os
import resource
import signal
import subprocess
import sys
import tempfile
import traceback

import languages

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "harness.py")
TRACER = os.path.join(HERE, "tracer.py")
TIMEOUT_SECONDS = 5
MAX_BODY_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 256 * 1024
MAX_TRACE_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_TESTS = 100
MAX_EXPRESSIONS = 20
MAX_CONDITIONS = 50
MAX_EXPR_CHARS = 200


def limit_resources(max_output):
    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT_SECONDS, TIMEOUT_SECONDS))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_output,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    os.setsid()


def spawn(script, payload, max_output):
    """Runs a script in a resource-limited subprocess; returns (report dict, None) or (None, failure result)."""
    # File redirection makes RLIMIT_FSIZE effective before any output enters server memory.
    with tempfile.TemporaryDirectory() as workdir, tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        proc = subprocess.Popen(
            [sys.executable, "-I", "-S", script],
            stdin=subprocess.PIPE, stdout=stdout_file, stderr=stderr_file,
            text=True, cwd=workdir, env={},
            preexec_fn=lambda: limit_resources(max_output),
        )
        try:
            proc.communicate(json.dumps(payload), timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            return None, {"status": "timeout"}
        finally:
            # Kill the whole session so forked children cannot linger.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
        stdout_file.seek(0)
        stdout = stdout_file.read(max_output).decode(errors="replace")
        stderr_file.seek(0, os.SEEK_END)
        stderr_file.seek(max(0, stderr_file.tell() - 2000))
        stderr = stderr_file.read(2000).decode(errors="replace")

    try:
        return json.loads(stdout[:max_output]), None
    except json.JSONDecodeError:
        # Hitting the CPU rlimit kills the process before the wall-clock timeout; report it the same way.
        if proc.returncode in (-signal.SIGXCPU, -signal.SIGKILL):
            return None, {"status": "timeout"}
        return None, {"status": "error", "error": stderr[-2000:] or f"process exited with code {proc.returncode}"}


def run(payload):
    language = payload.get("language", "python")
    code, entry_point, tests = payload["code"], payload["entry_point"], payload["tests"]
    if language != "python":
        return languages.run_tests(languages.BUILDERS[language], code, entry_point, payload.get("signature"), tests)
    args = [t["args"] for t in tests]
    report, failure = spawn(HARNESS, {"code": code, "entry_point": entry_point, "args": args}, MAX_OUTPUT_BYTES)
    if failure:
        return {**failure, "results": []}
    if "error" in report:
        return {"status": "error", "error": report["error"], "results": []}
    if len(report.get("results", [])) != len(tests):
        return {"status": "error", "error": "test harness produced an incomplete report", "results": []}
    return {"status": "ok", "results": [grade(test, item) for test, item in zip(tests, report["results"])]}


def grade(test, item):
    if isinstance(item, dict) and "value" in item:
        return {"passed": languages.matches(item["value"], test["expected"]), "actual": languages.short(item["value"])}
    error = item.get("error") if isinstance(item, dict) else None
    return {"passed": False, "error": str(error or "no result")[:languages.MAX_REPR]}


def trace(payload):
    language = payload.get("language", "python")
    if language != "python":
        spec = {k: payload[k] for k in ("args", "conditions", "eval") if k in payload}
        return languages.trace(languages.TRACERS[language], payload["code"], payload["entry_point"], payload.get("signature"), spec)
    report, failure = spawn(TRACER, payload, MAX_TRACE_OUTPUT_BYTES)
    if failure:
        return {**failure, "steps": []}
    return {"status": "ok", **report}


def valid(payload):
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("code"), str)
        and isinstance(payload.get("entry_point"), str)
        and payload["entry_point"].isidentifier()
        and isinstance(payload.get("tests"), list)
        and len(payload["tests"]) <= MAX_TESTS
        and all(isinstance(t, dict) and isinstance(t.get("args"), list) and "expected" in t for t in payload["tests"])
        and payload.get("language", "python") in languages.LANGUAGES
        and (payload.get("language") not in languages.NEEDS_SIGNATURE or valid_signature(payload.get("signature")))
    )


def valid_signature(signature):
    return (
        isinstance(signature, dict)
        and isinstance(signature.get("params"), list)
        and len(signature["params"]) <= 20
        and all(isinstance(p, dict) and p.get("type") in languages.TYPES for p in signature["params"])
        and signature.get("returns") in languages.TYPES
    )


def short_str(value):
    return isinstance(value, str) and len(value) <= MAX_EXPR_CHARS


def non_negative_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def valid_trace(payload):
    if not (
        isinstance(payload, dict)
        and isinstance(payload.get("code"), str)
        and isinstance(payload.get("entry_point"), str)
        and payload["entry_point"].isidentifier()
        and isinstance(payload.get("args"), list)
        and payload.get("language", "python") in languages.DEBUGGABLE
        and (payload.get("language") not in languages.NEEDS_SIGNATURE or valid_signature(payload.get("signature")))
    ):
        return False
    conditions = payload.get("conditions", [])
    if not (
        isinstance(conditions, list)
        and len(conditions) <= MAX_CONDITIONS
        and all(isinstance(c, dict) and non_negative_int(c.get("line")) and short_str(c.get("expr")) for c in conditions)
    ):
        return False
    ev = payload.get("eval")
    return ev is None or (
        isinstance(ev, dict)
        and non_negative_int(ev.get("step"))
        and non_negative_int(ev.get("frame"))
        and isinstance(ev.get("expressions"), list)
        and 0 < len(ev["expressions"]) <= MAX_EXPRESSIONS
        and all(short_str(e) for e in ev["expressions"])
    )


OPERATIONS = {"run": (valid, run), "trace": (valid_trace, trace)}


def main(argv):
    if len(argv) != 3 or argv[1] not in OPERATIONS:
        print("usage: main.py run|trace <job.json>", file=sys.stderr)
        return 2
    validator, handler = OPERATIONS[argv[1]]
    with open(argv[2], "rb") as f:
        body = f.read(MAX_BODY_BYTES + 1)
    if not body or len(body) > MAX_BODY_BYTES:
        print("invalid job size", file=sys.stderr)
        return 2
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        print("invalid json", file=sys.stderr)
        return 2
    if not validator(payload):
        print(f"invalid payload for {argv[1]}", file=sys.stderr)
        return 2
    try:
        result = handler(payload)
    except Exception:
        traceback.print_exc()
        return 1
    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
