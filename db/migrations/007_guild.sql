-- Guild extensions: last_active_at, contribution, auto_accept, weekly_score.

ALTER TABLE guilds ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN weekly_score INTEGER NOT NULL DEFAULT 0;

-- Add contribution column to guild_members (didn't exist in 001_init.sql)
ALTER TABLE guild_members ADD COLUMN contribution INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_guilds_active ON guilds(last_active_at);
CREATE INDEX IF NOT EXISTS idx_guild_members_contribution ON guild_members(contribution);