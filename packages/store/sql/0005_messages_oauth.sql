-- render-agents schema: messages (FK → threads) + oauth_connections (no FKs)
-- Dependency order position: 5

-- Human-facing thread transcript (distinct from per-agent run_messages).
-- PK is the source event coordinate so fold is an idempotent upsert.
-- run_id is a non-FK provenance column: transcript outlives run detail.
CREATE TABLE IF NOT EXISTS messages (
    run_id      TEXT NOT NULL,
    seq         BIGINT NOT NULL,
    tenant_id   TEXT NOT NULL,
    thread_id   TEXT NOT NULL REFERENCES threads(id),
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(tenant_id, thread_id);

-- OAuth connections — per-user tokens (encrypted at rest by application layer)
CREATE TABLE IF NOT EXISTS oauth_connections (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    expires_at    TIMESTAMPTZ,
    scopes        TEXT[] NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, user_id, provider)
);
