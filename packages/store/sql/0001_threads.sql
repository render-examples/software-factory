-- render-agents schema: threads (top-level, no FKs)
-- Dependency order position: 1

CREATE TABLE IF NOT EXISTS threads (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    user_id     TEXT,
    metadata    JSONB,
    status      TEXT NOT NULL DEFAULT 'active',
    title       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_threads_tenant ON threads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(tenant_id, user_id);
