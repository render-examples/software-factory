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

-- At most one run per issue while status = 'running'.
create unique index if not exists runs_one_active_per_issue
    on runs (issue_number)
    where status = 'running';

create index if not exists runs_created_at_idx
    on runs (created_at desc);
