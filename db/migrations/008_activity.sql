-- Activity calendar: per-server open/close windows for 25 activity systems.
-- activity_engine.ts reads from this table at startActivity().

CREATE TABLE IF NOT EXISTS activity_calendar (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL,
  server_id   TEXT NOT NULL,
  open_at     INTEGER NOT NULL,
  close_at    INTEGER NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(activity_id, server_id, open_at)
);

CREATE INDEX IF NOT EXISTS idx_activity_calendar_open
  ON activity_calendar(server_id, open_at);

-- Seed: login_sign_in is always open (open=0 means "always available since epoch")
INSERT OR IGNORE INTO activity_calendar(activity_id, server_id, open_at, close_at, params_json) VALUES
  (1, 's10001', 0, 9999999999, '{"rewardDay":7}'),
  (2, 's10001', 0, 9999999999, '{"cycleDays":30}'),
  (3, 's10001', 0, 9999999999, '{"rechargeBonus":500}');