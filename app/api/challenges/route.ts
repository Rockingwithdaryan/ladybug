import { listChallenges } from "@/server/challenges";
import { handle } from "@/server/http";

export const GET = handle(listChallenges);
