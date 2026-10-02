-- Drop tables: stage_id -> item_id probability map.
-- Loaded into memory at battle-arbitrator startup; queries are cache hits, not DB.

CREATE TABLE IF NOT EXISTS drop_tables (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_id  INTEGER NOT NULL,
  item_id   INTEGER NOT NULL,
  weight    INTEGER NOT NULL,
  min_qty   INTEGER NOT NULL DEFAULT 1,
  max_qty   INTEGER NOT NULL DEFAULT 1,
  UNIQUE(stage_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_drop_tables_stage ON drop_tables(stage_id);

CREATE TABLE IF NOT EXISTS drop_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role_uuid   TEXT NOT NULL,
  stage_id    INTEGER NOT NULL,
  item_id     INTEGER NOT NULL,
  qty         INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_drop_history_role
  ON drop_history(role_uuid);

-- Seed a few entries so the drop system has data
INSERT OR IGNORE INTO drop_tables(stage_id, item_id, weight, min_qty, max_qty) VALUES
  (100, 1, 100, 50, 100),       -- gold 50-100
  (100, 2, 30,  10, 30),        -- exp 10-30
  (100, 100, 5,  1, 1),         -- rare hero shard
  (101, 1, 100, 100, 200),      -- stage 101: more gold
  (101, 3, 50,  5, 15),         -- diamond 5-15
  (200, 1, 80,  500, 1000),     -- boss stage
  (200, 100, 20, 1, 3);         -- boss shards