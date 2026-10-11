import { handle } from "@/server/http";
import { startOAuth } from "@/server/oauth";

export const GET = handle(startOAuth);
