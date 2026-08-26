-- Thread-centric data model: surfaces + items
-- Threads own their notification surfaces and user-facing timeline.
-- Runs are always thread-bound; channel info moves off runs to surfaces.

-- 1. thread_surfaces: where to deliver notifications for a thread
CREATE TABLE IF NOT EXISTS thread_surfaces (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   TEXT NOT NULL,
    thread_id   TEXT NOT NULL REFERENCES threads(id),
    channel     TEXT NOT NULL,
    address     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, thread_id, channel, address)
);
CREATE INDEX IF NOT EXISTS idx_thread_surfaces_thread ON thread_surfaces (tenant_id, thread_id);
ALTER TABLE thread_surfaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_thread_surfaces ON thread_surfaces
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- 2. thread_items: user-facing timeline (messages, results, status)
CREATE TABLE IF NOT EXISTS thread_items (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   TEXT NOT NULL,
    thread_id   TEXT NOT NULL REFERENCES threads(id),
    run_id      TEXT REFERENCES runs(id),
    seq         BIGINT NOT NULL,
    kind        TEXT NOT NULL,
    role        TEXT,
    content     TEXT,
    data        JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (thread_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_thread_items_thread ON thread_items (tenant_id, thread_id, seq);
ALTER TABLE thread_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_thread_items ON thread_items
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- 3. Modify runs: add kind + parent_run_id
ALTER TABLE runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'interactive';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT REFERENCES runs(id);
CREATE INDEX IF NOT EXISTS idx_runs_parent_run ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

-- 4. Relax the one-active-run constraint: only interactive runs are exclusive
DROP INDEX IF EXISTS idx_runs_thread_active;
CREATE UNIQUE INDEX idx_runs_thread_active ON runs (tenant_id, thread_id)
    WHERE status IN ('pending', 'running', 'paused') AND kind = 'interactive';

-- 5. Drop channel/external_conversation_id from runs (surfaces own this now)
ALTER TABLE runs DROP COLUMN IF EXISTS channel;
ALTER TABLE runs DROP COLUMN IF EXISTS external_conversation_id;

-- 6. Drop channel_conversations table (replaced by thread_surfaces)
DROP TABLE IF EXISTS channel_conversations;

-- 7. Drop messages table (replaced by thread_items)
DROP TABLE IF EXISTS messages;
