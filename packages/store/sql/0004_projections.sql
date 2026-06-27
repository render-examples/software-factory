-- render-agents schema: projection tables (FK → runs)
-- Dependency order position: 4

-- Spans — observability tree
CREATE TABLE IF NOT EXISTS spans (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    parent_id   TEXT,
    seq         INTEGER NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',
    input       JSONB,
    output      JSONB,
    error       TEXT,
    attributes  JSONB,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_spans_run_id ON spans(run_id);

-- Tool calls — idempotency index
CREATE TABLE IF NOT EXISTS tool_calls (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES runs(id),
    idempotency_key TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    input           JSONB,
    result_content  TEXT,
    result_is_error BOOLEAN DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'pending',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_idempotency ON tool_calls(run_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);

-- Run messages — per-agent LLM history
CREATE TABLE IF NOT EXISTS run_messages (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    agent_name  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    role        TEXT NOT NULL,
    content     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_messages_run_agent ON run_messages(run_id, agent_name, seq);

-- Workflow steps — memoized ctx.step() results
CREATE TABLE IF NOT EXISTS workflow_steps (
    run_id      TEXT NOT NULL REFERENCES runs(id),
    name        TEXT NOT NULL,
    result      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, name)
);

-- Approval requests
CREATE TABLE IF NOT EXISTS approval_requests (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id),
    tool_name    TEXT NOT NULL,
    tool_input   JSONB,
    agent_name   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ,
    resolved_by  TEXT,
    reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_run_id ON approval_requests(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);

-- Schedules
CREATE TABLE IF NOT EXISTS schedules (
    id              TEXT PRIMARY KEY,
    workflow        TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    input           JSONB,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_run_id     TEXT REFERENCES runs(id),
    last_run_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
