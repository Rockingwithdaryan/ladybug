import { handle } from "@/server/http";
import { runProblem } from "@/server/problems";

// Starts a sandbox and may compile: up to ~35s of runner time (server/runner.ts).
export const maxDuration = 60;

export const POST = handle(runProblem);
