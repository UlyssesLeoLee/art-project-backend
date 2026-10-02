-- Hot-path indexes (DB-013 part 2).
-- These cover the columns used in WHERE/JOIN clauses hit on every login,
-- every TCP handshake, and every order query.

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_accounts_platform_account ON accounts(platform, account);
CREATE INDEX IF NOT EXISTS idx_orders_role_status ON orders(role_uuid, status);
CREATE INDEX IF NOT EXISTS idx_heroes_role_hero ON heroes(role_uuid, hero_id);
