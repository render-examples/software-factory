-- render-agents schema: tenant-scope schedules.
-- Dependency order position: 11 (alters schedules from 0001/0006)
--
-- Schedules were the one control-plane resource with no owner, so the gateway
-- could not confine them per tenant. Add `user_id` (stamped from auth at create
-- time); cron-fired runs inherit it so they are tenant-scoped like any other run.
-- Nullable: pre-existing / operator-created schedules simply have no owner and
-- remain operator-only. Indexed for the per-tenant list.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);
