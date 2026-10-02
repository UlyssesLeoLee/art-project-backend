-- Push scheduler audit log.
-- lib/push-scheduler.ts writes here on every push sent.

CREATE TABLE IF NOT EXISTS push_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role_uuid   TEXT NOT NULL,
  push_name   TEXT NOT NULL,
  message_id  INTEGER NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  sent_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_push_log_role ON push_log(role_uuid, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_log_name ON push_log(push_name);