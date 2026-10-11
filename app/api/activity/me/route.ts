import { myActivity } from "@/server/activity";
import { handle } from "@/server/http";

export const GET = handle(myActivity);
