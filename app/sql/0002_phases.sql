-- Phase model tables and runs table evolution.
-- Applies cleanly on top of 0001_init.sql with existing data.

-- ── deliveries ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deliveries (
    delivery_id   text        PRIMARY KEY,
    event         text        NOT NULL,
    action        text        NOT NULL,
    outcome       text        NOT NULL,
    detail        jsonb,
    received_at   timestamptz NOT NULL DEFAULT now()
);

-- ── schema_migrations (used by the migrate script) ──────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text        PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ── evolve runs ─────────────────────────────────────────────────────

-- Add new columns, keeping old ones until data is migrated.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS repo              text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS subject_kind      text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS subject_number    integer;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workflow          text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger           jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS input             jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS stage             text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS outcome           text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result            jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS previous_run_id   text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_after    timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatched_at     timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS heartbeat_at      timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS started_at        timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS completed_at      timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cost_usd          numeric(12,6) NOT NULL DEFAULT 0;

-- Backfill repo for old rows: use 'unknown/unknown' since the old schema
-- had no repo column — the deployment was bound to FACTORY_REPO at runtime
-- and that value is not available in a pure SQL migration.
UPDATE runs SET repo = 'unknown/unknown' WHERE repo IS NULL;
ALTER TABLE runs ALTER COLUMN repo SET NOT NULL;

-- Backfill subject_kind and subject_number from the old issue_number column.
UPDATE runs SET subject_kind = 'issue', subject_number = issue_number
WHERE subject_kind IS NULL AND issue_number IS NOT NULL;

-- Backfill workflow for old rows (the only existing workflow).
UPDATE runs SET workflow = 'spec-to-pr' WHERE workflow IS NULL;
ALTER TABLE runs ALTER COLUMN workflow SET NOT NULL;

-- Map old statuses to the new status/outcome model.
-- running stays running; terminal statuses → completed with the old status as outcome.
UPDATE runs SET outcome = status, status = 'completed', completed_at = updated_at
WHERE status IN ('draft_pr_opened', 'needs_clarification', 'no_changes', 'changes_requested');

UPDATE runs SET outcome = 'error', status = 'failed', completed_at = updated_at
WHERE status = 'failed' AND outcome IS NULL;

-- Fold branch and pull_request into result jsonb.
UPDATE runs SET result = jsonb_build_object(
    'branch', branch,
    'pullRequest', pull_request
)
WHERE (branch IS NOT NULL OR pull_request IS NOT NULL) AND result IS NULL;

-- Drop the old unique index (it references issue_number and old status values).
DROP INDEX IF EXISTS runs_one_active_per_issue;

-- New partial unique index: at most one non-terminal run per subject.
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_subject
    ON runs (repo, subject_kind, subject_number)
    WHERE status IN ('queued', 'dispatched', 'running');

-- New runs use the deliveries table instead of runs.delivery_id.
-- Make delivery_id nullable so new rows can omit it.
ALTER TABLE runs ALTER COLUMN delivery_id DROP NOT NULL;

-- New runs use subject_kind + subject_number instead of issue_number.
-- Make issue_number nullable so new rows can omit it.
ALTER TABLE runs ALTER COLUMN issue_number DROP NOT NULL;

-- ── run_events ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS run_events (
    id              bigserial   PRIMARY KEY,
    run_id          text        NOT NULL REFERENCES runs(id),
    type            text        NOT NULL,
    stage           text,
    span_id         text,
    parent_span_id  text,
    phase           text,
    payload         jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events (run_id, id);

-- ── specs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS specs (
    id                text        PRIMARY KEY,
    repo              text        NOT NULL,
    issue_number      integer     NOT NULL,
    status            text        NOT NULL DEFAULT 'draft',
    current_version   integer     NOT NULL DEFAULT 0,
    approved_version  integer,
    approved_by       text,
    approved_at       timestamptz,
    comment_id        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- At most one non-superseded spec per issue.
CREATE UNIQUE INDEX IF NOT EXISTS specs_one_active_per_issue
    ON specs (repo, issue_number)
    WHERE status != 'superseded';

-- ── spec_versions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spec_versions (
    spec_id         text        NOT NULL REFERENCES specs(id),
    version         integer     NOT NULL,
    document        jsonb       NOT NULL,
    markdown        text        NOT NULL,
    notes           jsonb,
    last_comment_id text,
    run_id          text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (spec_id, version)
);

-- ── sandboxes ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sandboxes (
    id              text        PRIMARY KEY,
    provider_id     text,
    status          text        NOT NULL DEFAULT 'creating',
    base_sha        text,
    lockfile_hash   text,
    run_id          text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    ready_at        timestamptz,
    expires_at      timestamptz,
    terminated_at   timestamptz
);

CREATE INDEX IF NOT EXISTS sandboxes_status_idx ON sandboxes (status);

-- ── artifacts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
    id              text        PRIMARY KEY,
    run_id          text        NOT NULL REFERENCES runs(id),
    kind            text        NOT NULL,
    content_type    text        NOT NULL,
    bytes           bytea       NOT NULL,
    size            integer     NOT NULL,
    sha256          text        NOT NULL,
    link_token_hash text        UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS artifacts_run_id_idx ON artifacts (run_id);
CREATE INDEX IF NOT EXISTS artifacts_expires_idx ON artifacts (expires_at);
