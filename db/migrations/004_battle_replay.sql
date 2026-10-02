-- Battle replays: when client opts into NeedFightReplay, server re-simulates
-- and compares hash to detect tampering. Replays kept 7d for auditing.

CREATE TABLE IF NOT EXISTS battle_replays (
  uuid          TEXT PRIMARY KEY,
  role_uuid     TEXT NOT NULL,
  replay_json   TEXT NOT NULL,
  replay_hash   TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_battle_replays_role
  ON battle_replays(role_uuid);

CREATE INDEX IF NOT EXISTS idx_battle_replays_expires
  ON battle_replays(expires_at);