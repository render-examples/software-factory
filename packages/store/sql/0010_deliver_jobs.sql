-- render-agents schema: exempt `deliver` jobs from the one-active-job-per-run
-- invariant.
-- Dependency order position: 10 (alters run_jobs from 0007)
--
-- A `deliver` job is a post-processing SIDE-EFFECT (push a completed reply — or a
-- pending HITL input prompt — back to a channel surface), NOT a turn driver.
-- Under the original per-run unique index it could not coexist with the run's
-- still-active `agent`/`resume` job, so the delivery producer's enqueue — fired
-- the instant `run.completed`/`run.paused` is committed, while that turn job is
-- still `running` — conflicted with it and was silently dropped. This is most
-- acute on `run.paused` (HITL), where the turn job is ALWAYS still active when the
-- pause commits. Excluding `deliver` from the index lets it coexist; deliver jobs
-- carry their own idempotency (by explicit id) in the queue's `enqueue`.
DROP INDEX IF EXISTS idx_run_jobs_run_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_jobs_run_active
    ON run_jobs(run_id) WHERE status IN ('queued', 'running') AND kind <> 'deliver';
