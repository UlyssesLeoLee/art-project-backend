-- SQLite schema for art-project-backend
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uuid TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL,
  account TEXT,
  token_hash TEXT,
  device_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_accounts_account ON accounts(account);
CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uuid TEXT NOT NULL,
  session_id TEXT UNIQUE NOT NULL,
  token TEXT NOT NULL,
  server_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (account_uuid) REFERENCES accounts(account_uuid)
);
CREATE INDEX IF NOT EXISTS idx_sessions_uuid ON sessions(account_uuid);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uuid TEXT NOT NULL,
  server_id TEXT NOT NULL,
  role_uuid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  exp INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  diamond INTEGER NOT NULL DEFAULT 0,
  vip_level INTEGER NOT NULL DEFAULT 0,
  gender INTEGER NOT NULL DEFAULT 0,
  head_icon TEXT,
  sign TEXT,
  battle_power INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (account_uuid) REFERENCES accounts(account_uuid)
);
CREATE INDEX IF NOT EXISTS idx_roles_uuid ON roles(account_uuid);

CREATE TABLE IF NOT EXISTS heroes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hero_uuid TEXT UNIQUE NOT NULL,
  role_uuid TEXT NOT NULL,
  hero_id INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  exp INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 1,
  star INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (role_uuid) REFERENCES roles(role_uuid)
);
CREATE INDEX IF NOT EXISTS idx_heroes_role ON heroes(role_uuid);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_uuid TEXT UNIQUE NOT NULL,
  role_uuid TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (role_uuid) REFERENCES roles(role_uuid)
);

CREATE TABLE IF NOT EXISTS formations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  formation_uuid TEXT UNIQUE NOT NULL,
  role_uuid TEXT NOT NULL,
  type INTEGER NOT NULL,
  hero_uuids TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (role_uuid) REFERENCES roles(role_uuid)
);

CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_uuid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  exp INTEGER NOT NULL DEFAULT 0,
  notice TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS guild_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_uuid TEXT NOT NULL,
  role_uuid TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(guild_uuid, role_uuid),
  FOREIGN KEY (guild_uuid) REFERENCES guilds(guild_uuid)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  role_uuid TEXT NOT NULL,
  goods_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  platform TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  paid_at INTEGER,
  FOREIGN KEY (role_uuid) REFERENCES roles(role_uuid)
);

CREATE TABLE IF NOT EXISTS reddots (
  role_uuid TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role_uuid, key)
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_uuid TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  progress TEXT NOT NULL DEFAULT '{}',
  reward_claimed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(role_uuid, activity_id)
);

CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_uuid TEXT UNIQUE NOT NULL,
  role_uuid TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  rewards TEXT NOT NULL DEFAULT '[]',
  read INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS gm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_uuid TEXT NOT NULL,
  cmd TEXT NOT NULL,
  args TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
