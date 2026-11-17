-- One row per Workflows task run, from its run.started on the thread stream (or its run.rejected) and its run:<id> stream.
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
  -- 'reply' when the run finished waiting for a reply on its thread.
  waiting     text,
  sandbox_id  text,
  started_at  timestamptz not null,
  finished_at timestamptz,
  updated_seq bigint not null
);
create index runs_trace on runs (trace_id);
create index runs_thread on runs (thread);

-- The latest run started on each thread, such as an issue or pull request, derived from its thread:<thread> stream.
-- Its trace owns the thread while any of the trace's runs is running.
create table threads (
  thread            text primary key,
  trace_id          text not null,
  run_id            text not null,
  -- Operational: the comment the status view is synced to. db:rebuild keeps it.
  status_comment_id bigint,
  updated_seq       bigint not null
);

-- Threads whose work runs on another thread, such as a factory pull request's on its issue's, from thread.linked.
create table thread_links (
  thread      text primary key,
  linked_to   text not null,
  updated_seq bigint not null
);
