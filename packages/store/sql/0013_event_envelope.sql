-- Event envelope: artifact references, correlation, and classification.
--
-- Large content uses artifact references instead of inline payload. The append
-- path rejects oversized payloads rather than silently truncating. The 8 KB
-- limit matches the Postgres LISTEN/NOTIFY payload cap.

ALTER TABLE run_events ADD COLUMN IF NOT EXISTS artifact_refs JSONB;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS classification TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS causation_id TEXT;
ALTER TABLE run_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_run_events_correlation
    ON run_events(tenant_id, correlation_id)
    WHERE correlation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_idempotency
    ON run_events(tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE run_events DROP CONSTRAINT IF EXISTS run_events_payload_bounded;
ALTER TABLE run_events ADD CONSTRAINT run_events_payload_bounded
    CHECK (pg_column_size(payload) <= 8000) NOT VALID;
