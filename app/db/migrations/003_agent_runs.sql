-- One row per agent run, derived from its agent_run:<id> stream. No operational columns.
create table agent_runs (
  id          text primary key,
  run_id      text not null,        -- the Workflows task run
  subject     text,
  agent_id    text not null,
  model       text not null,
  state       text not null,        -- running, ok, or an error code
  turns       int,
  usage       jsonb,
  cost_usd    numeric,
  tool_calls  int not null default 0,
  started_at  timestamptz not null,
  finished_at timestamptz,
  updated_seq bigint not null
);
