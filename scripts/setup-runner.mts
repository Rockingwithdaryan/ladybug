/**
 * Builds the Vercel Sandbox snapshot that user code runs in: installs the compilers, debuggers and runtimes the
 * runner needs, copies runner/ in, then checks every language from a fresh sandbox with exactly the settings the API
 * uses. Prints the snapshot id to set as RUNNER_SNAPSHOT_ID. Re-run it after changing anything in runner/.
 *
 * Usage: npm run runner:setup (after `vercel link` and `vercel env pull`, or with VERCEL_TOKEN/TEAM_ID/PROJECT_ID set)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
import { Sandbox } from "@vercel/sandbox";
import { RUNNER_DIR, createJobSandbox, runJob, sandboxCredentials } from "../server/sandbox";

nextEnv.loadEnvConfig(process.cwd(), true);

const IMAGE = "vercel/sandbox/node:24";
// The JDK (javac, java, and JDI for the Java debugger), GCC and gdb for C/C++, and the JSON libraries the C/C++ test
// drivers link against. The image already has Node; Python comes from apt.
const APT_PACKAGES = ["python3", "default-jdk-headless", "gcc", "g++", "gdb", "libc6-dev", "libcjson-dev", "nlohmann-json3-dev"];
// languages/node_common.js loads the TypeScript compiler from /opt/typescript.
const TYPESCRIPT = "typescript@5.9.3";
const LOCAL_RUNNER = path.join(process.cwd(), "runner");
const UPLOAD_DIR = "/tmp/runner-upload";

async function sh(sandbox: Sandbox, script: string, { sudo = false } = {}) {
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: ["-euo", "pipefail", "-c", script],
    sudo,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  if (result.exitCode !== 0) throw new Error(`setup step failed (exit ${result.exitCode}): ${script}`);
}

async function runnerFiles(dir = LOCAL_RUNNER): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await runnerFiles(full)));
    else files.push(path.relative(LOCAL_RUNNER, full).split(path.sep).join("/"));
  }
  return files;
}

async function install(sandbox: Sandbox) {
  console.log(`\n▸ Installing ${APT_PACKAGES.join(", ")}`);
  await sh(sandbox, `apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${APT_PACKAGES.join(" ")}`, {
    sudo: true,
  });

  console.log(`\n▸ Installing ${TYPESCRIPT}`);
  await sh(
    sandbox,
    `npm install -g --no-fund --no-audit ${TYPESCRIPT} && ln -sfn "$(npm root -g)/typescript" /opt/typescript
     # languages/node.py runs /usr/local/bin/node.
     [ -x /usr/local/bin/node ] || ln -s "$(command -v node)" /usr/local/bin/node`,
    { sudo: true },
  );

  console.log("\n▸ Copying runner/");
  const files = await runnerFiles();
  const dirs = [...new Set(files.map((f) => path.posix.dirname(`${UPLOAD_DIR}/${f}`)))];
  await sh(sandbox, `mkdir -p ${dirs.map((d) => `'${d}'`).join(" ")}`);
  await sandbox.writeFiles(
    await Promise.all(files.map(async (f) => ({ path: `${UPLOAD_DIR}/${f}`, content: await readFile(path.join(LOCAL_RUNNER, f)) }))),
  );
  // Owned by root, so even within a job's sandbox user code can't modify the runner.
  await sh(sandbox, `rm -rf ${RUNNER_DIR} && cp -r ${UPLOAD_DIR} ${RUNNER_DIR} && rm -rf ${UPLOAD_DIR}`, { sudo: true });

  console.log("\n▸ Precompiling the C++ prelude and the Java debugger");
  await sh(
    sandbox,
    `cd ${RUNNER_DIR}
     # Flags must match CXXFLAGS in languages/cpp.py, or GCC silently ignores the precompiled header.
     g++ -std=gnu++17 -O1 -x c++-header languages/cpp_prelude.hpp -o languages/cpp_prelude.hpp.gch
     javac -g -d languages/jdi languages/JdiTracer.java languages/Json.java
     chmod -R a+rX ${RUNNER_DIR}`,
    { sudo: true },
  );

  await sh(sandbox, "python3 --version; node --version; java -version 2>&1 | sed -n 1p; gcc --version | sed -n 1p; gdb --version | sed -n 1p");
}

const ADD: Record<string, string> = {
  python: "def add(a, b):\n    return a + b\n",
  javascript: "function add(a, b) {\n  return a + b;\n}\n",
  typescript: "function add(a: number, b: number): number {\n  return a + b;\n}\n",
  java: "class Solution {\n    public int add(int a, int b) {\n        return a + b;\n    }\n}\n",
  c: "int add(int a, int b) {\n    return a + b;\n}\n",
  cpp: "class Solution {\npublic:\n    int add(int a, int b) {\n        return a + b;\n    }\n};\n",
};
const signature = { params: [{ name: "a", type: "int" }, { name: "b", type: "int" }], returns: "int" };

type Run = { status: string; error?: string; results: { passed: boolean }[] };
type Trace = { status: string; error?: string; steps: unknown[] };

/** Runs and traces a tiny solution in every language, and the runner's own regression tests. */
async function verify(snapshotId: string) {
  console.log("\n▸ Checking every language in a fresh sandbox (no network, as in production)");
  const sandbox = await createJobSandbox(snapshotId);
  const failures: string[] = [];
  try {
    for (const [language, code] of Object.entries(ADD)) {
      const job = { code, entry_point: "add", language, signature };
      const checks = {
        run: () => runJob<Run>(sandbox, "run", { ...job, tests: [{ args: [1, 2], expected: 3 }, { args: [-4, 4], expected: 0 }] }, 60_000)
          .then((r) => r.status === "ok" && r.results.length === 2 && r.results.every((t) => t.passed) ? null : JSON.stringify(r)),
        debug: () => runJob<Trace>(sandbox, "trace", { ...job, args: [1, 2], conditions: [] }, 60_000)
          .then((r) => (r.status === "ok" && r.steps.length > 0 ? null : JSON.stringify(r))),
      };
      const outcome: string[] = [];
      for (const [name, check] of Object.entries(checks)) {
        const problem = await check().catch((err: unknown) => String(err));
        outcome.push(`${name} ${problem ? "FAILED" : "ok"}`);
        if (problem) failures.push(`${language} ${name}: ${problem.slice(0, 1000)}`);
      }
      console.log(`  ${language.padEnd(10)} ${outcome.join(", ")}`);
    }
    const tests = await sandbox.runCommand({ cmd: "python3", args: ["-m", "unittest", "-q", "test_regressions"], cwd: RUNNER_DIR });
    console.log(`  runner regression tests ${tests.exitCode === 0 ? "ok" : "FAILED"}`);
    if (tests.exitCode !== 0) failures.push(`regression tests: ${(await tests.stderr()).slice(-2000)}`);
  } finally {
    await sandbox.stop();
  }
  return failures;
}

console.log(`Creating a setup sandbox from ${IMAGE}…`);
const sandbox = await Sandbox.create({
  image: IMAGE,
  resources: { vcpus: 2 },
  timeout: 30 * 60_000,
  persistent: false,
  ...sandboxCredentials(),
});
let snapshotId: string;
try {
  await install(sandbox);
  console.log("\n▸ Saving the snapshot");
  // Never expires: the app needs it for as long as RUNNER_SNAPSHOT_ID points at it. Taking it stops the sandbox.
  snapshotId = (await sandbox.snapshot({ expiration: 0 })).snapshotId;
} catch (err) {
  await sandbox.stop().catch(() => {});
  throw err;
}

const failures = await verify(snapshotId);
if (failures.length) {
  console.error(`\nThe snapshot ${snapshotId} doesn't work yet:\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log(`\nDone. Set this environment variable locally (.env) and in the Vercel project:\n\nRUNNER_SNAPSHOT_ID=${snapshotId}\n`);
