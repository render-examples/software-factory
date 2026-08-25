-- Inbox deliveries and durable commands.
--
-- These tables are operational records, not event-log projections.
-- They are authoritative for delivery acceptance and command leases.

CREATE TABLE IF NOT EXISTS inbox_deliveries (
    tenant_id     TEXT        NOT NULL,
    provider      TEXT        NOT NULL,
    delivery_id   TEXT        NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload_digest TEXT       NOT NULL,
    command_id    TEXT,
    PRIMARY KEY (tenant_id, provider, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox_deliveries(tenant_id, received_at DESC);

-- Commands exist before policy creates a run, so they cannot use run_jobs.
CREATE TABLE IF NOT EXISTS commands (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead')),
    payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    attempts      INT         NOT NULL DEFAULT 0,
    max_attempts  INT         NOT NULL DEFAULT 5,
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at     TIMESTAMPTZ,
    locked_by     TEXT,
    lease_token   TEXT,
    dedupe_key    TEXT,
    correlation_id TEXT,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_dedupe
    ON commands(tenant_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commands_claimable
    ON commands(tenant_id, status, available_at)
    WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_commands_lease
    ON commands(id, lease_token)
    WHERE lease_token IS NOT NULL;

ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_lease_matches_status;
ALTER TABLE commands ADD CONSTRAINT commands_lease_matches_status
    CHECK ((status = 'running') = (lease_token IS NOT NULL)) NOT VALID;

-- RLS for new tables
ALTER TABLE inbox_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_inbox ON inbox_deliveries
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_commands ON commands
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
