-- Arena seasons + rankings. Refresh is a cron job that rolls over seasons
-- and resets rankings.

CREATE TABLE IF NOT EXISTS arena_seasons (
  season_id    INTEGER PRIMARY KEY,
  start_at     INTEGER NOT NULL,
  end_at       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS arena_rankings (
  season_id    INTEGER NOT NULL,
  role_uuid    TEXT NOT NULL,
  mode         INTEGER NOT NULL,
  score        INTEGER NOT NULL DEFAULT 0,
  rank_pos     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (season_id, mode, role_uuid)
);

CREATE INDEX IF NOT EXISTS idx_arena_rankings_score
  ON arena_rankings(season_id, mode, score DESC);

-- Seed first season (1 month, now+30d)
INSERT OR IGNORE INTO arena_seasons(season_id, start_at, end_at, status)
  VALUES (1, strftime('%s','now'), strftime('%s','now','+30 days'), 'active');