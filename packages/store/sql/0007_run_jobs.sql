-- render-agents schema: run_jobs — the durable job queue (control plane).
-- Dependency order position: 7 (FK → runs)
--
-- A job is a POINTER, not state: run identity/input/trigger already live in the
-- run.started event (D10). A row only references the run + what to do with it
-- (kind) so a runner can claim it via SELECT ... FOR UPDATE SKIP LOCKED and
-- drive the root run / resume. This is an operational table (like `schedules`),
-- never a projection of the event log.
--
-- ON DELETE CASCADE: jobs are ephemeral and tied to a run's lifetime. When
-- retention deletes a terminal run summary (DELETE FROM runs), its jobs go with
-- it rather than blocking the delete.

CREATE TABLE IF NOT EXISTS run_jobs (
    id            TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                   -- 'agent' | 'resume' (chat lane only; workflows use Render)
    status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | dead
    priority      INT  NOT NULL DEFAULT 100,       -- lower runs sooner (interactive < batch)
    payload       JSONB,                           -- target name, plan, identity (forward-flex)
    attempts      INT  NOT NULL DEFAULT 0,         -- claim count (delivery/crash-loop budget)
    max_attempts  INT  NOT NULL DEFAULT 5,         -- delivery budget; D3 logic-retry is the runner's job
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at     TIMESTAMPTZ,
    locked_by     TEXT,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: claim scans queued, due jobs in (priority, availability) order.
CREATE INDEX IF NOT EXISTS idx_run_jobs_claim
    ON run_jobs(status, priority, available_at);

-- Reaper: find stale running jobs by lock age.
CREATE INDEX IF NOT EXISTS idx_run_jobs_locked ON run_jobs(locked_at)
    WHERE status = 'running';

-- At most one active (queued/running) job per run — makes enqueue idempotent
-- under duplicate triggers and prevents two runners double-driving one run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_jobs_run_active
    ON run_jobs(run_id) WHERE status IN ('queued', 'running');
