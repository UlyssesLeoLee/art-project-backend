-- Rate limit: token bucket persistence.
-- lib/rate-limit.ts writes here on every checkRateLimit().

CREATE TABLE IF NOT EXISTS rate_buckets (
  bucket_key   TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_buckets_window
  ON rate_buckets(window_start);