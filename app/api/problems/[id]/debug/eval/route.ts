import { handle } from "@/server/http";
import { evalProblem } from "@/server/problems";

// Starts a sandbox and traces under a debugger: up to ~37s of runner time (server/runner.ts).
export const maxDuration = 60;

export const POST = handle(evalProblem);
