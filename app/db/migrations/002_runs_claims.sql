-- One row per Workflows task run, derived from its run:<id> stream.
create table runs (
  run_id      text primary key,
  trace_id    text not null,
  task        text not null,
  title       text not null,
  subject     text not null,
  state       text not null,
  summary     text,
  outcome     text,
  links       jsonb,
  sandbox_id  text,
  started_at  timestamptz not null,
  finished_at timestamptz,
  updated_seq bigint not null
);
create index runs_trace on runs (trace_id);
create index runs_subject on runs (subject);

-- The trace that owns each issue or pull request, derived from its subject:<subject> stream.
create table claims (
  subject           text primary key,
  stream_version    int not null,
  trace_id          text not null,
  run_id            text not null,
  state             text not null,
  -- Operational: the comment the status view is synced to. db:rebuild keeps it.
  status_comment_id bigint,
  updated_seq       bigint not null
);
