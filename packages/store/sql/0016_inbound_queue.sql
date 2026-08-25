-- Durable inbound message queue. Webhooks persist here before acknowledging,
-- so a process crash never loses a message. A worker claims and processes.

CREATE TABLE IF NOT EXISTS inbound_messages (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    delivery_id     TEXT NOT NULL,
    channel         TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_id       TEXT,
    user_id         TEXT,
    input           JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ,
    UNIQUE (tenant_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_tenant_status ON inbound_messages(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_inbound_conversation ON inbound_messages(tenant_id, channel, conversation_id);

ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_inbound ON inbound_messages
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS conversation_jobs (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    message_id      TEXT NOT NULL REFERENCES inbound_messages(id),
    channel         TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued',
    locked_by       TEXT,
    locked_at       TIMESTAMPTZ,
    lease_token     TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_jobs_claimable
    ON conversation_jobs(tenant_id, status, created_at)
    WHERE status = 'queued';

ALTER TABLE conversation_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_conv_jobs ON conversation_jobs
    USING (tenant_id = current_setting('app.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
