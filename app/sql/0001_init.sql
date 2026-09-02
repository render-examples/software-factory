-- One row per factory run.
--
-- Two constraints do work that would otherwise need application code:
--
--   * runs.delivery_id is unique, so a redelivered GitHub webhook cannot
--     start a second run for the same delivery.
--   * runs_one_active_per_issue is a partial unique index, so at most one
--     run can be in flight for an issue at a time.
--
-- Both are enforced by a single INSERT ... ON CONFLICT DO NOTHING in
-- app/store.ts: zero rows inserted means "someone else already has this".

create table if not exists runs (
    id            text primary key,
    delivery_id   text        not null unique,
    issue_number  integer     not null,
    status        text        not null default 'running',
    branch        text,
    pull_request  text,
    summary       text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create unique index if not exists runs_one_active_per_issue
    on runs (issue_number)
    where status = 'running';

create index if not exists runs_created_at_idx
    on runs (created_at desc);
