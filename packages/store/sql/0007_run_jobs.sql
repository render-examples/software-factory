-- render-agents schema: run_jobs — the durable job queue (control plane).
-- Dependency order position: 7 (FK → runs)

CREATE TABLE IF NOT EXISTS run_jobs (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',
    priority      INT  NOT NULL DEFAULT 100,
    payload       JSONB,
    attempts      INT  NOT NULL DEFAULT 0,
    max_attempts  INT  NOT NULL DEFAULT 5,
    lease_token   TEXT,
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at     TIMESTAMPTZ,
    locked_by     TEXT,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: claim scans queued, due jobs in (tenant, priority, availability) order.
CREATE INDEX IF NOT EXISTS idx_run_jobs_claim
    ON run_jobs(tenant_id, status, priority, available_at);

-- Reaper: find stale running jobs by lock age.
CREATE INDEX IF NOT EXISTS idx_run_jobs_locked ON run_jobs(locked_at)
    WHERE status = 'running';

-- At most one active (queued/running) non-deliver job per run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_jobs_run_active
    ON run_jobs(run_id) WHERE status IN ('queued', 'running') AND kind <> 'deliver';
