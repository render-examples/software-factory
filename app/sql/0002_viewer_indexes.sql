-- The run viewer lists runs newest first and loads one trace's events.
create index if not exists events_type_id on events (type, id desc);
create index if not exists events_trace_id on events (trace_id, id);

-- Claims moved to the status comment; nothing queries run.claimed rows any more.
drop index if exists events_current_run_claim;
