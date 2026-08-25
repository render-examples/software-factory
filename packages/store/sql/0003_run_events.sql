-- render-agents schema: run_events — the canonical append-only event log
-- Dependency order position: 3 (FK → runs)

CREATE TABLE IF NOT EXISTS run_events (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    seq             BIGINT NOT NULL,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
    category        TEXT NOT NULL,
    type            TEXT NOT NULL,
    agent_name      TEXT,
    span_id         TEXT,
    parent_span_id  TEXT,
    payload         JSONB NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_seq ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(run_id, type);
CREATE INDEX IF NOT EXISTS idx_run_events_tenant ON run_events(tenant_id);

-- Gap-free seq allocation per run. Called inside the append transaction.
-- A transaction-scoped advisory lock keyed on the run id genuinely serializes
-- concurrent writers on the same run (MAX(seq)+1 alone races under READ
-- COMMITTED); the lock auto-releases at COMMIT/ROLLBACK. The unique index on
-- (run_id, seq) remains a correctness backstop.
CREATE OR REPLACE FUNCTION next_event_seq(p_run_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    next_val BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('render-agents:run_seq'), hashtext(p_run_id));
    SELECT COALESCE(MAX(seq), 0) + 1 INTO next_val
    FROM run_events
    WHERE run_id = p_run_id;
    RETURN next_val;
END;
$$;
