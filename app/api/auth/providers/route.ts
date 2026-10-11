import { providers } from "@/server/auth";
import { handle } from "@/server/http";

export const GET = handle(providers);
