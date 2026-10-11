import { startChallenge } from "@/server/challenges";
import { handle } from "@/server/http";

// Generation calls Gemini and verifies each attempt in sandboxes, up to three times. Keep in sync with
// GENERATION_TIMEOUT_SECONDS in server/challenges.ts.
export const maxDuration = 300;

export const POST = handle(startChallenge);
