-- GM admin: extend gm_log with admin_user + action + ip.
-- lib/gm-admin.ts writes here on every execGmCommand.

ALTER TABLE gm_log ADD COLUMN admin_user TEXT NOT NULL DEFAULT '';
ALTER TABLE gm_log ADD COLUMN action_taken TEXT NOT NULL DEFAULT '';
ALTER TABLE gm_log ADD COLUMN ip TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_gm_log_admin_time
  ON gm_log(admin_user, created_at DESC);