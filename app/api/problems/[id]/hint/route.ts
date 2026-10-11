import { handle } from "@/server/http";
import { hintProblem } from "@/server/problems";

// Gemini can be slow under load, and retries on overload (server/gemini.ts).
export const maxDuration = 60;

export const POST = handle(hintProblem);
