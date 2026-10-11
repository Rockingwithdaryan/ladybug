import { me } from "@/server/auth";
import { handle } from "@/server/http";

export const GET = handle(me);
