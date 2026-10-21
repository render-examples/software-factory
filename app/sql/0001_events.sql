create table events (
	id         bigserial primary key,
	trace_id   text not null,
	run_id     text,
	repo       text,
	subject    text,
	type       text not null,
	payload    jsonb not null default '{}',
	created_at timestamptz not null default now()
);
create index events_current_run_claim
	on events (repo, subject, id desc)
	where type = 'run.claimed';
