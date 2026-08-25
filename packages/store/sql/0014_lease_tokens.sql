-- Fencing tokens on job leases.
--
-- A token issued for each claim prevents a stale worker from settling a job
-- after the reaper re-queues it for another worker.

CREATE INDEX IF NOT EXISTS idx_run_jobs_lease
    ON run_jobs(id, lease_token)
    WHERE lease_token IS NOT NULL;

-- A stopped job must not keep a valid lease token.
ALTER TABLE run_jobs DROP CONSTRAINT IF EXISTS run_jobs_lease_matches_status;
ALTER TABLE run_jobs ADD CONSTRAINT run_jobs_lease_matches_status
    CHECK ((status = 'running') = (lease_token IS NOT NULL)) NOT VALID;
