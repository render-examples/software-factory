-- Artifact storage for large event payloads.
-- When an event payload exceeds 8KB, large fields are extracted here and
-- replaced with refs in the event's artifact_refs column. On read, the store
-- transparently hydrates them back into the payload.

CREATE TABLE IF NOT EXISTS artifacts (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    field_path  TEXT NOT NULL,
    content     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (tenant_id, run_id);

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_artifacts ON artifacts
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
