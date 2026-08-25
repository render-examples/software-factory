-- render-agents schema: channel binding on runs + the conversation mapping.
-- Dependency order position: 9 (after runs).

ALTER TABLE runs ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS external_conversation_id TEXT;

CREATE TABLE IF NOT EXISTS channel_conversations (
    tenant_id                TEXT NOT NULL,
    channel                  TEXT NOT NULL,
    external_conversation_id TEXT NOT NULL,
    thread_id                TEXT,
    last_run_id              TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, channel, external_conversation_id)
);
