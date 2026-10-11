import { logout } from "@/server/auth";
import { handle } from "@/server/http";

export const POST = handle(logout);
