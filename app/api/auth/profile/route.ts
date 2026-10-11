import { updateProfile } from "@/server/auth";
import { handle } from "@/server/http";

export const PATCH = handle(updateProfile);
