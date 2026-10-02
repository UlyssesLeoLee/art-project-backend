-- Orders: extend with SDK delivery metadata.
-- paid_at already in 001_init.sql; we add delivered_at, sdk_platform, sdk_txn_id, callback_payload_json.

ALTER TABLE orders ADD COLUMN delivered_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN sdk_platform TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN sdk_txn_id TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN callback_payload_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_orders_sdk_txn ON orders(sdk_txn_id);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at);