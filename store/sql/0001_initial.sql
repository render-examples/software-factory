CREATE SCHEMA IF NOT EXISTS render_factory;

CREATE TABLE IF NOT EXISTS render_factory.schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS render_factory.runs (
    id                    TEXT PRIMARY KEY,
    kind                  TEXT NOT NULL CHECK (kind IN ('workflow', 'agent', 'task')),
    name                  TEXT NOT NULL,
    status                TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    root_run_id           TEXT NOT NULL,
    parent_run_id         TEXT,
    parent_step_key       TEXT,
    trigger_type          TEXT,
    trigger_ref           TEXT,
    definition_version    TEXT,
    input                 JSONB,
    result                JSONB,
    error_code            TEXT,
    failure_count         INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    total_input_tokens    BIGINT NOT NULL DEFAULT 0 CHECK (total_input_tokens >= 0),
    total_output_tokens   BIGINT NOT NULL DEFAULT 0 CHECK (total_output_tokens >= 0),
    total_model_calls     INTEGER NOT NULL DEFAULT 0 CHECK (total_model_calls >= 0),
    total_cost_usd        NUMERIC,
    next_event_seq        BIGINT NOT NULL DEFAULT 0,
    next_execution_fence  BIGINT NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at            TIMESTAMPTZ,
    finished_at           TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    details_deleted_at    TIMESTAMPTZ,
    CONSTRAINT runs_parent_fk FOREIGN KEY (parent_run_id)
        REFERENCES render_factory.runs(id) ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT runs_root_fk FOREIGN KEY (root_run_id)
        REFERENCES render_factory.runs(id) ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS runs_status_created
    ON render_factory.runs(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS runs_name_created
    ON render_factory.runs(name, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS runs_root
    ON render_factory.runs(root_run_id, created_at, id);
CREATE INDEX IF NOT EXISTS runs_parent
    ON render_factory.runs(parent_run_id, created_at, id)
    WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_trigger
    ON render_factory.runs(trigger_type, trigger_ref)
    WHERE trigger_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS render_factory.run_executions (
    id                TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL REFERENCES render_factory.runs(id) ON DELETE CASCADE,
    attempt           INTEGER NOT NULL CHECK (attempt > 0),
    status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'lost')),
    token              TEXT NOT NULL,
    fence              BIGINT NOT NULL CHECK (fence > 0),
    lease_expires_at   TIMESTAMPTZ NOT NULL,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at        TIMESTAMPTZ,
    error_code         TEXT,
    UNIQUE (run_id, attempt),
    UNIQUE (run_id, fence)
);

CREATE UNIQUE INDEX IF NOT EXISTS run_executions_active
    ON render_factory.run_executions(run_id)
    WHERE status = 'running';
CREATE INDEX IF NOT EXISTS run_executions_expired
    ON render_factory.run_executions(lease_expires_at)
    WHERE status = 'running';

CREATE TABLE IF NOT EXISTS render_factory.run_events (
    position          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id                TEXT NOT NULL UNIQUE,
    run_id            TEXT NOT NULL REFERENCES render_factory.runs(id) ON DELETE CASCADE,
    seq               BIGINT NOT NULL,
    ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
    category          TEXT NOT NULL CHECK (category IN ('lifecycle', 'execution', 'step', 'agent', 'external')),
    type              TEXT NOT NULL,
    execution_id      TEXT,
    step_key          TEXT,
    agent_name        TEXT,
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
    payload_digest    TEXT NOT NULL,
    version           INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    idempotency_key   TEXT,
    correlation_id    TEXT,
    causation_id      TEXT,
    UNIQUE (run_id, seq),
    CONSTRAINT run_events_payload_bounded
        CHECK (pg_column_size(payload) <= 8192)
);

CREATE UNIQUE INDEX IF NOT EXISTS run_events_idempotency
    ON render_factory.run_events(run_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_events_run_seq
    ON render_factory.run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS run_events_type
    ON render_factory.run_events(type, ts DESC);
CREATE INDEX IF NOT EXISTS run_events_correlation
    ON render_factory.run_events(correlation_id)
    WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS render_factory.run_steps (
    run_id         TEXT NOT NULL REFERENCES render_factory.runs(id) ON DELETE CASCADE,
    step_key       TEXT NOT NULL,
    generation     INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    status         TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'invalidated')),
    replay_policy  TEXT NOT NULL CHECK (replay_policy IN ('safe', 'guarded')),
    execution_id   TEXT,
    result         JSONB,
    error_code     TEXT,
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    duration_ms    BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, step_key)
);

CREATE INDEX IF NOT EXISTS run_steps_status
    ON render_factory.run_steps(run_id, status);

CREATE TABLE IF NOT EXISTS render_factory.run_links (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES render_factory.runs(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    url          TEXT,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, kind, external_id)
);

CREATE INDEX IF NOT EXISTS run_links_external
    ON render_factory.run_links(kind, external_id);

CREATE TABLE IF NOT EXISTS render_factory.inbox_deliveries (
    provider        TEXT NOT NULL,
    delivery_id     TEXT NOT NULL,
    run_id          TEXT REFERENCES render_factory.runs(id) ON DELETE SET NULL,
    subject_key     TEXT,
    payload_digest  TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'completed')),
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at   TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider, delivery_id)
);

CREATE INDEX IF NOT EXISTS inbox_deliveries_run
    ON render_factory.inbox_deliveries(run_id)
    WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_deliveries_expiry
    ON render_factory.inbox_deliveries(expires_at);

CREATE TABLE IF NOT EXISTS render_factory.leases (
    resource_key        TEXT PRIMARY KEY,
    owner_id            TEXT NOT NULL,
    token               TEXT NOT NULL,
    fence               BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    expires_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leases_expiry
    ON render_factory.leases(expires_at);

CREATE TABLE IF NOT EXISTS render_factory.artifacts (
    ref          TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES render_factory.runs(id) ON DELETE CASCADE,
    namespace    TEXT NOT NULL,
    media_type   TEXT NOT NULL,
    content      BYTEA NOT NULL,
    size_bytes   BIGINT NOT NULL CHECK (size_bytes >= 0),
    sha256       TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    accessed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS artifacts_run
    ON render_factory.artifacts(run_id);
CREATE INDEX IF NOT EXISTS artifacts_expiry
    ON render_factory.artifacts(expires_at);

CREATE TABLE IF NOT EXISTS render_factory.conversations (
    id           TEXT PRIMARY KEY,
    provider     TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS conversations_expiry
    ON render_factory.conversations(expires_at);

CREATE TABLE IF NOT EXISTS render_factory.conversation_messages (
    id                   TEXT PRIMARY KEY,
    conversation_id      TEXT NOT NULL REFERENCES render_factory.conversations(id) ON DELETE CASCADE,
    run_id               TEXT REFERENCES render_factory.runs(id) ON DELETE SET NULL,
    external_message_id  TEXT NOT NULL,
    role                 TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content              TEXT NOT NULL,
    occurred_at          TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, external_message_id)
);

CREATE INDEX IF NOT EXISTS conversation_messages_recent
    ON render_factory.conversation_messages(conversation_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS render_factory.outbound_deliveries (
    provider         TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    run_id           TEXT REFERENCES render_factory.runs(id) ON DELETE SET NULL,
    content          TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
    provider_ref     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider, operation_id)
);

CREATE INDEX IF NOT EXISTS outbound_deliveries_expiry
    ON render_factory.outbound_deliveries(expires_at);

CREATE TABLE IF NOT EXISTS render_factory.knowledge_entries (
    namespace   TEXT NOT NULL,
    key         TEXT NOT NULL,
    content     TEXT NOT NULL,
    version     BIGINT NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    PRIMARY KEY (namespace, key)
);

CREATE INDEX IF NOT EXISTS knowledge_entries_expiry
    ON render_factory.knowledge_entries(expires_at)
    WHERE expires_at IS NOT NULL;

INSERT INTO render_factory.schema_migrations (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;
