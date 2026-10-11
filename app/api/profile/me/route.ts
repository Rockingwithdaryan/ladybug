import { handle } from "@/server/http";
import { myProfile } from "@/server/profile";

export const GET = handle(myProfile);
