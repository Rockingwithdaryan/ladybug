import { handle } from "@/server/http";
import { getProblem } from "@/server/problems";

export const GET = handle(getProblem);
