import { handle } from "@/server/http";
import { oauthCallback } from "@/server/oauth";

export const GET = handle(oauthCallback);
