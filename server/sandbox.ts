import { Sandbox } from "@vercel/sandbox";

/**
 * User code runs in Vercel Sandbox: a fresh Firecracker microVM per job, booted from a snapshot that already has
 * every toolchain and the runner (runner/) installed. `npm run runner:setup` builds that snapshot. Shared by the
 * API (server/runner.ts) and the setup script, which checks the snapshot under exactly the API's settings.
 */

/** Where the setup script installs runner/ inside the snapshot. */
export const RUNNER_DIR = "/opt/ladybug-runner";
const JOB_FILE = "/tmp/job.json";
// A backstop only: jobs are capped well below this and the sandbox is stopped as soon as one finishes.
const SANDBOX_TIMEOUT_MS = 2 * 60_000;

/** An access token, for running outside Vercel without `vercel env pull`. On Vercel the SDK uses OIDC instead. */
export function sandboxCredentials() {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

export function createJobSandbox(snapshotId: string) {
  return Sandbox.create({
    source: { type: "snapshot", snapshotId },
    // Untrusted code gets no network at all, and the VM holds no secrets.
    networkPolicy: "deny-all",
    // A job's VM is thrown away afterwards; persistence would snapshot it on every stop.
    persistent: false,
    resources: { vcpus: 2 },
    timeout: SANDBOX_TIMEOUT_MS,
    ...sandboxCredentials(),
  });
}

export class RunnerError extends Error {}

/** Runs one runner job (`python3 main.py run|trace`) in the sandbox and returns its JSON report. */
export async function runJob<T>(sandbox: Sandbox, op: "run" | "trace", payload: unknown, timeoutMs: number): Promise<T> {
  await sandbox.writeFiles([{ path: JOB_FILE, content: JSON.stringify(payload) }]);
  const command = await sandbox.runCommand({ cmd: "python3", args: [`${RUNNER_DIR}/main.py`, op, JOB_FILE], timeoutMs });
  // Read one stream at a time; the SDK warns that reading both in parallel can race.
  const stdout = await command.stdout();
  if (command.exitCode !== 0) {
    const stderr = await command.stderr();
    throw new RunnerError(`runner exited with code ${command.exitCode}: ${stderr.slice(-2000)}`);
  }
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new RunnerError(`runner printed invalid JSON: ${stdout.slice(0, 200)}`);
  }
}
