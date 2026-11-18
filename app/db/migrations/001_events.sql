create table events (
  seq             bigserial primary key,
  tx              xid8 not null default pg_current_xact_id(),
  stream          text not null,
  stream_version  int  not null,
  thread          text,
  type            text not null,
  version         int  not null default 1,
  source          text not null,
  idempotency_key text unique,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  unique (stream, stream_version)
);
create index events_thread_order on events (thread, tx, seq) where thread is not null;
