-- State that used to live in the Express process's memory. Serverless instances share no memory, so it moves here.

-- Fixed-window rate limit counters (see server/rateLimit.ts).
CREATE TABLE IF NOT EXISTS rate_limits (
  key      text PRIMARY KEY,
  hits     int NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx ON rate_limits (reset_at);

-- Challenge generations in progress. Generating takes ~30s, so this stops a double click or a second tab from starting
-- two, and lets the UI show that one is running. A row older than the request time limit is a crashed request's
-- leftover and is ignored.
CREATE TABLE IF NOT EXISTS challenge_generations (
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('daily', 'weekly')),
  period_start date NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, period_start)
);
