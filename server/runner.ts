import type { Sandbox } from "@vercel/sandbox";
import { after } from "next/server";
import { getConfig } from "./config";
import { HttpError } from "./errors";
import type { Language, Signature } from "./languages";
import { createJobSandbox, runJob } from "./sandbox";

export type TestCase = { args: unknown[]; expected: unknown };
export type TestResult = { passed: boolean; actual?: string; error?: string };
export type RunResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
  results: TestResult[];
};

export type TraceFrame = { name: string; line: number; locals: Record<string, string> };
export type TraceStep = {
  line: number;
  event: "line" | "return" | "exception";
  depth: number;
  /** Length of captured stdout at this step. */
  out: number;
  frames: TraceFrame[];
  value?: string;
  exception?: string;
  cond?: boolean;
  condError?: string;
};
export type TraceResult = {
  status: "ok" | "error" | "timeout";
  steps: TraceStep[];
  stdout?: string;
  result?: string;
  /** Compile error or uncaught exception raised by the solution. */
  error?: string;
  truncated?: boolean;
};
export type EvalResult = {
  status: "ok" | "error" | "timeout";
  values?: ({ value: string } | { error: string })[];
  error?: string;
};
export type BreakpointCondition = { line: number; expr: string };

/** Stops the sandbox after the response is sent, so the user doesn't wait for it. */
function stopLater(sandbox: Sandbox) {
  const stop = () => sandbox.stop().catch((err) => console.warn("sandbox not stopped", err));
  try {
    after(stop);
  } catch {
    // Outside a request (scripts), there's nothing to defer to.
    void stop();
  }
}

// Maximum compilation + execution budget is 30 seconds, plus overhead.
async function callRunner<T>(op: "run" | "trace", payload: unknown, timeoutMs = 35_000): Promise<T> {
  const snapshotId = getConfig().RUNNER_SNAPSHOT_ID;
  if (!snapshotId) throw new HttpError(503, "The code runner isn't set up yet (RUNNER_SNAPSHOT_ID is missing)");
  let sandbox: Sandbox;
  try {
    sandbox = await createJobSandbox(snapshotId);
  } catch (err) {
    console.error("could not start a runner sandbox", err);
    throw new HttpError(503, "Code runner is unavailable");
  }
  try {
    return await runJob<T>(sandbox, op, payload, timeoutMs);
  } catch (err) {
    console.error("runner job failed", err);
    throw new HttpError(502, "The code runner failed to execute this request");
  } finally {
    stopLater(sandbox);
  }
}

/**
 * Executes code against test cases in a sandbox. Statically typed languages need the signature so the runner can
 * turn JSON arguments into native values.
 */
export function runTests(
  code: string,
  entryPoint: string,
  tests: TestCase[],
  language: Language = "python",
  signature?: Signature | null,
): Promise<RunResult> {
  return callRunner("run", { code, entry_point: entryPoint, tests, language, signature: signature ?? undefined });
}

/** Compiling with debug info and stepping under gdb/JDI takes longer than a test run. */
// Maximum compilation + tracing budget is 32 seconds, plus overhead.
const TRACE_TIMEOUT_MS = 37_000;

/** Records every executed line of one call so the client can step through it like a debugger. */
export function traceCode(
  code: string,
  entryPoint: string,
  args: unknown[],
  conditions: BreakpointCondition[] = [],
  language: Language = "python",
  signature?: Signature | null,
): Promise<TraceResult> {
  return callRunner(
    "trace",
    { code, entry_point: entryPoint, args, conditions, language, signature: signature ?? undefined },
    TRACE_TIMEOUT_MS,
  );
}

/** Replays the same call up to `step` and evaluates expressions in the given stack frame (0 = innermost). */
export function evalAtStep(
  code: string,
  entryPoint: string,
  args: unknown[],
  at: { step: number; frame: number; expressions: string[]; conditions?: BreakpointCondition[] },
  language: Language = "python",
  signature?: Signature | null,
): Promise<EvalResult> {
  const { conditions = [], ...evalSpec } = at;
  return callRunner(
    "trace",
    {
      code,
      entry_point: entryPoint,
      args,
      conditions,
      eval: evalSpec,
      language,
      signature: signature ?? undefined,
    },
    TRACE_TIMEOUT_MS,
  );
}

export function allPassed(run: RunResult, total: number) {
  return run.status === "ok" && run.results.length === total && run.results.every((r) => r.passed);
}
