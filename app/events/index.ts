import pg from "pg";

/** One row in the append-only `events` table: telemetry only. Nothing reads it back to decide what a run does. */
export interface FactoryEvent {
	/** The root task run of the task (or the gateway's delivery id for deliveries that started nothing). */
	traceId: string;
	/** The task run that emitted the event, when there is one. */
	runId?: string;
	/** "owner/name" */
	repo?: string;
	/** "issue#12" or "pr#34" */
	subject?: string;
	/** Dotted name: delivery.received, run.started, run.finished, agent.started, agent.finished, cost, ... */
	type: string;
	payload?: Record<string, unknown>;
}

let pool: pg.Pool | undefined;

function db(): pg.Pool | undefined {
	if (pool) return pool;
	const connectionString = process.env.DATABASE_URL?.trim();
	if (!connectionString) return undefined;
	pool = new pg.Pool({
		connectionString,
		max: 3,
		application_name: "software-factory",
		connectionTimeoutMillis: 3_000,
		idleTimeoutMillis: 10_000,
		allowExitOnIdle: true,
		options: "-c statement_timeout=5000 -c lock_timeout=2000",
	});
	// An idle client losing its connection must not crash the process.
	pool.on("error", (error) => warn("events pool error", error));
	return pool;
}

function warn(msg: string, error: unknown, fields: Record<string, unknown> = {}): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ level: "warn", msg, ...fields, error: message }));
}

/** Appends one event. Never throws and never blocks a run on the database; a no-op without DATABASE_URL. */
export async function emit(event: FactoryEvent): Promise<void> {
	try {
		const p = db();
		if (!p) return;
		await p.query("insert into events (trace_id, run_id, repo, subject, type, payload) values ($1, $2, $3, $4, $5, $6)", [
			event.traceId,
			event.runId ?? null,
			event.repo ?? null,
			event.subject ?? null,
			event.type,
			JSON.stringify(event.payload ?? {}),
		]);
	} catch (error) {
		warn("event dropped", error, { type: event.type, traceId: event.traceId });
	}
}

/** One task run as the viewer lists it: its `run.started` event, how it finished, and what its agents cost. */
export interface RunSummary {
	/** The `run.started` event's id: the pagination cursor. */
	id: number;
	traceId: string;
	runId: string | null;
	repo: string | null;
	subject: string | null;
	task: string | null;
	actor: string | null;
	startedAt: string;
	/** Null while running, or when the run was killed before anything recorded how it ended. */
	finishedAt: string | null;
	state: string | null;
	outcome: string | null;
	costUsd: number | null;
	agentRuns: number;
}

export interface TraceEvent {
	id: number;
	at: string;
	type: string;
	runId: string | null;
	subject: string | null;
	payload: Record<string, unknown>;
}

/** Task runs, newest first: up to `limit` whose `run.started` id is below `before`. Null without DATABASE_URL. */
export async function listRuns(opts: { before?: number; limit: number }): Promise<RunSummary[] | null> {
	const p = db();
	if (!p) return null;
	const { rows } = await p.query(
		`select s.id::text, s.trace_id, s.run_id, s.repo, s.subject, s.created_at as started_at,
			s.payload->>'stage' as task, s.payload->>'actor' as actor,
			f.created_at as finished_at, f.payload->>'state' as state, f.payload->>'outcome' as outcome,
			a.cost_usd::text, a.agent_runs::int
		from events s
		left join lateral (
			select created_at, payload from events
			where trace_id = s.trace_id and run_id is not distinct from s.run_id and type = 'run.finished'
			order by id desc limit 1
		) f on true
		left join lateral (
			select sum((payload->>'costUsd')::numeric) as cost_usd, count(*) as agent_runs from events
			where trace_id = s.trace_id and type = 'agent.finished'
		) a on true
		where s.type = 'run.started' and ($1::bigint is null or s.id < $1)
		order by s.id desc
		limit $2`,
		[opts.before ?? null, opts.limit],
	);
	return rows.map((r) => ({
		id: Number(r.id),
		traceId: r.trace_id,
		runId: r.run_id,
		repo: r.repo,
		subject: r.subject,
		task: r.task,
		actor: r.actor,
		startedAt: r.started_at.toISOString(),
		finishedAt: r.finished_at?.toISOString() ?? null,
		state: r.state,
		outcome: r.outcome,
		costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
		agentRuns: r.agent_runs,
	}));
}

/** Every event of one trace, oldest first, up to `limit`. Null without DATABASE_URL. */
export async function listTraceEvents(traceId: string, limit = 1000): Promise<TraceEvent[] | null> {
	const p = db();
	if (!p) return null;
	const { rows } = await p.query("select id::text, created_at, type, run_id, subject, payload from events where trace_id = $1 order by id limit $2", [
		traceId,
		limit,
	]);
	return rows.map((r) => ({
		id: Number(r.id),
		at: r.created_at.toISOString(),
		type: r.type,
		runId: r.run_id,
		subject: r.subject,
		payload: r.payload,
	}));
}

/** Ends the pool so scripts can exit. */
export async function closeEvents(): Promise<void> {
	const p = pool;
	pool = undefined;
	await p?.end();
}
