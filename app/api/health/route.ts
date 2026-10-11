import { db } from "@/server/db";
import { handle } from "@/server/http";

export const GET = handle(async () => {
  await db().query("SELECT 1");
  return Response.json({ ok: true });
});
