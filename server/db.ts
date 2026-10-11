import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { getConfig } from "./config";

let pool: pg.Pool | undefined;

/** One small pool per function instance; serverless instances are many, so each keeps few connections. */
export function db() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: getConfig().DATABASE_URL, max: 5, idleTimeoutMillis: 10_000 });
    // Releases idle clients before Vercel suspends the instance, so they don't count against the database's limit.
    attachDatabasePool(pool);
  }
  return pool;
}
