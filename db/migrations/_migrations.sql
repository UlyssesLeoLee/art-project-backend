-- Version tracking table for db/migrations/run.ts.
-- Created automatically by the runner before any other migration is applied.

CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
