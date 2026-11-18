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
  finished_at timestamptz,
  updated_seq bigint not null
);
create index runs_trace on runs (trace_id);
create index runs_thread on runs (thread);

create table threads (
  thread            text primary key,
  trace_id          text not null,
  run_id            text not null,
  status_comment_id bigint,
  updated_seq       bigint not null
);

create table thread_links (
  thread      text primary key,
  linked_to   text not null,
  updated_seq bigint not null
);
