-- render-agents schema: runs (FK → threads)
-- Dependency order position: 2

CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    workflow        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    input           JSONB,
    result          JSONB,
    error           TEXT,
    trigger         TEXT,
    total_cost_usd  NUMERIC NOT NULL DEFAULT 0,
    thread_id       TEXT REFERENCES threads(id),
    user_id         TEXT,
    agent_version   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_runs_tenant ON runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_runs_tenant_status ON runs(tenant_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(tenant_id, workflow);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(tenant_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(tenant_id, user_id);

-- At most one active (pending/running/paused) run per thread within a tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_thread_active
    ON runs(tenant_id, thread_id)
    WHERE status IN ('pending', 'running', 'paused');
