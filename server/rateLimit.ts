import { db } from "./db";
import { HttpError } from "./errors";

export type RateLimit = {
  /** Namespaces the counters, so one key can be limited by several rules. */
  name: string;
  windowMs: number;
  limit: number;
  message?: string;
};

/**
 * Counts a request against a fixed-window limit and throws 429 once it's exceeded. Counters live in Postgres
 * because serverless instances share no memory; an in-process counter would reset on every cold start.
 */
export async function rateLimit(rule: RateLimit, key: string) {
  const { rows } = await db().query<{ hits: number; retry_after: number }>(
    `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, now() + $2 * interval '1 millisecond')
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
     RETURNING hits, ceil(extract(epoch FROM reset_at - now()))::int AS retry_after`,
    [`${rule.name}:${key}`, rule.windowMs],
  );
  // Expired counters are only reset lazily, so clear out old ones now and then.
  if (Math.random() < 0.01) {
    db()
      .query("DELETE FROM rate_limits WHERE reset_at < now()")
      .catch((err) => console.warn("rate limit cleanup failed", err));
  }
  if (rows[0].hits > rule.limit) {
    throw new HttpError(429, rule.message ?? "Too many requests, please try again later.", {
      "Retry-After": String(Math.max(1, rows[0].retry_after)),
    });
  }
}

/** Takes back one counted request, for limits that only count failures. */
export async function refundRateLimit(rule: RateLimit, key: string) {
  await db().query("UPDATE rate_limits SET hits = hits - 1 WHERE key = $1 AND hits > 0", [`${rule.name}:${key}`]);
}
