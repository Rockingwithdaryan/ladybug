import { handle } from "@/server/http";
import { listProblems } from "@/server/problems";

export const GET = handle(listProblems);
