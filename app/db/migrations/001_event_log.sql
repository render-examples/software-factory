create table events (
  seq             bigserial primary key,
  tx              xid8 not null default pg_current_xact_id(),
  stream          text not null,
  stream_version  int not null,
  thread          text,
  type            text not null,
  version         int not null,
  source          text not null,
  idempotency_key text unique,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  unique (stream, stream_version)
);
create index events_thread_order on events (thread, tx, seq) where thread is not null;

create table runs (
  run_id      text primary key,
  trace_id    text not null,
  task        text not null,
  title       text not null,
  thread      text not null,
  state       text not null,
  summary     text,
  outcome     text,
  links       jsonb,
  waiting     text,
  sandbox_id  text,
  started_at  timestamptz not null,
  finished_at timestamptz
);
create index runs_trace on runs (trace_id);
create index runs_thread on runs (thread);

create table threads (
  thread            text primary key,
  trace_id          text not null,
  run_id            text not null,
  status_comment_id bigint
);

create table agent_runs (
  id          text primary key,
  run_id      text not null,
  thread      text,
  agent_id    text not null,
  model       text not null,
  state       text not null,
  turns       int,
  usage       jsonb,
  cost_usd    numeric,
  tool_calls  int not null default 0,
  started_at  timestamptz not null,
  finished_at timestamptz
);
