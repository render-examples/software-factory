-- Snapshot-based sandboxes.
-- Applies cleanly on top of 0002_phases.sql with existing data.

-- ── snapshots ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS snapshots (
    id                text        PRIMARY KEY,
    sandbox_group_id  text        NOT NULL,
    name              text        NOT NULL,
    repo              text        NOT NULL,
    base_sha          text        NOT NULL,
    lockfile_hash     text        NOT NULL,
    build_key         text        NOT NULL,
    status            text        NOT NULL DEFAULT 'available',
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz,
    retired_at        timestamptz
);

CREATE INDEX IF NOT EXISTS snapshots_repo_status_idx
    ON snapshots (repo, status)
    WHERE status = 'available';

-- ── evolve sandboxes ────────────────────────────────────────────────
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS role        text;
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS snapshot_id text;

