-- Chat: messages + mutes. Required for regulatory compliance (CN/JP/KR).
-- chat-engine.ts writes here on every send().

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,
  sender_uuid TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_time
  ON chat_messages(channel, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_mutes (
  role_uuid   TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_chat_mutes_expires
  ON chat_mutes(expires_at);