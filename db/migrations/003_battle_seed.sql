-- Battle seed table for client-authoritative battle verification.
-- Server issues a RandomSeed per battle; client must report result within TTL,
-- otherwise seed is expired and result rejected (anti-cheat).

CREATE TABLE IF NOT EXISTS battle_seeds (
  uuid            TEXT PRIMARY KEY,
  role_uuid       TEXT NOT NULL,
  fight_mod       INTEGER NOT NULL,
  stage_id        INTEGER NOT NULL,
  random_seed     INTEGER NOT NULL,
  difficulty_rank INTEGER NOT NULL DEFAULT 0,
  need_replay     INTEGER NOT NULL DEFAULT 0,
  power_snapshot  TEXT NOT NULL DEFAULT '{}',
  needs_replay    INTEGER NOT NULL DEFAULT 0,
  update_fight_mod INTEGER NOT NULL DEFAULT 0,
  update_stage_id  INTEGER NOT NULL DEFAULT 0,
  stage_dynamic_difficulty INTEGER NOT NULL DEFAULT 0,
  battle_check_realpwoer INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_battle_seeds_role_expires
  ON battle_seeds(role_uuid, expires_at);

CREATE INDEX IF NOT EXISTS idx_battle_seeds_expires
  ON battle_seeds(expires_at);