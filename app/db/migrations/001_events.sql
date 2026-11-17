-- Append-only log; the source of truth for factory state. Projections are derived from it.
create table events (
  seq             bigserial primary key,
  tx              xid8 not null default pg_current_xact_id(),
  stream          text not null,
  stream_version  int  not null,
  subject         text,
  type            text not null,
  version         int  not null default 1,
  source          text not null,
  idempotency_key text unique,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  unique (stream, stream_version)
);
create index events_subject_order on events (subject, tx, seq) where subject is not null;
