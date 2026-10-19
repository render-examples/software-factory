create index events_current_run_claim
	on events (repo, subject, id desc)
	where type = 'run.claimed';
