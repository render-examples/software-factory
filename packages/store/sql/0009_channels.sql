-- render-agents schema: channel binding on runs + the conversation mapping.
-- Dependency order position: 9 (after runs).
--
-- `channels/*.ts` are the single inbound/outbound message surface. A run
-- triggered by a channel carries the channel id + the external conversation id
-- so (a) a re-entrant inbound message resumes the same thread and (b) outbound
-- delivery can address the originating surface.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS external_conversation_id TEXT;

-- The channel "continuation token": (channel, externalConversationId) → thread.
-- `last_run_id` is a plain pointer (no FK): retention may delete the run, and
-- the mapping should outlive it (like the thread transcript).
CREATE TABLE IF NOT EXISTS channel_conversations (
    channel                  TEXT NOT NULL,
    external_conversation_id TEXT NOT NULL,
    thread_id                TEXT,
    last_run_id              TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel, external_conversation_id)
);
