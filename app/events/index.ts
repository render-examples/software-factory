import pg from "pg";
import type { FactoryEvent, StoredEvent, TraceSummary } from "./types.js";

export type { FactoryEvent, StoredEvent, TraceSummary } from "./types.js";

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

function requireDb(): pg.Pool {
	const p = db();
	if (!p) throw new Error("DATABASE_URL is not set");
	return p;
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
		await p.query(
			"insert into events (trace_id, run_id, repo, subject, type, payload) values ($1, $2, $3, $4, $5, $6)",
			[
				event.traceId,
				event.runId ?? null,
				event.repo ?? null,
				event.subject ?? null,
				event.type,
				JSON.stringify(event.payload ?? {}),
			],
		);
	} catch (error) {
		warn("event dropped", error, { type: event.type, traceId: event.traceId });
	}
}

interface TraceRow {
	trace_id: string;
	repo: string | null;
	subject: string | null;
	first_at: Date;
	last_at: Date;
	event_count: string;
	first_type: string;
	last_type: string;
}

/** The most recent traces, newest activity first. `before` pages by last event time. */
export async function listTraces(options: { repo?: string; limit: number; before?: Date }): Promise<TraceSummary[]> {
	const { rows } = await requireDb().query<TraceRow>(
		`select trace_id,
			max(repo) as repo,
			max(subject) as subject,
			min(created_at) as first_at,
			max(created_at) as last_at,
			count(*) as event_count,
			(array_agg(type order by id))[1] as first_type,
			(array_agg(type order by id desc))[1] as last_type
		from events
		where ($1::text is null or repo = $1)
		group by trace_id
		having ($3::timestamptz is null or max(created_at) < $3)
		order by last_at desc
		limit $2`,
		[options.repo ?? null, Math.max(1, Math.min(options.limit, 500)), options.before ?? null],
	);
	return rows.map((row) => ({
		traceId: row.trace_id,
		repo: row.repo,
		subject: row.subject,
		firstAt: row.first_at,
		lastAt: row.last_at,
		eventCount: Number(row.event_count),
		firstType: row.first_type,
		lastType: row.last_type,
	}));
}

interface EventRow {
	id: string;
	trace_id: string;
	run_id: string | null;
	repo: string | null;
	subject: string | null;
	type: string;
	payload: Record<string, unknown>;
	created_at: Date;
}

/** Every event in one trace, in insertion order. */
export async function traceEvents(traceId: string): Promise<StoredEvent[]> {
	const { rows } = await requireDb().query<EventRow>(
		"select id, trace_id, run_id, repo, subject, type, payload, created_at from events where trace_id = $1 order by id",
		[traceId],
	);
	return rows.map(storedEvent);
}

/** The newest events matching every given filter, newest first. `before` pages by event time. */
export async function recentEvents(options: {
	types?: string[];
	traceIds?: string[];
	repo?: string;
	limit: number;
	before?: Date;
}): Promise<StoredEvent[]> {
	const { rows } = await requireDb().query<EventRow>(
		`select id, trace_id, run_id, repo, subject, type, payload, created_at
		from events
		where ($1::text[] is null or type = any($1))
			and ($2::text[] is null or trace_id = any($2))
			and ($3::text is null or repo = $3)
			and ($4::timestamptz is null or created_at < $4)
		order by id desc
		limit $5`,
		[
			options.types ?? null,
			options.traceIds ?? null,
			options.repo ?? null,
			options.before ?? null,
			Math.max(1, Math.min(options.limit, 2000)),
		],
	);
	return rows.map(storedEvent);
}

function storedEvent(row: EventRow): StoredEvent {
	return {
		id: row.id,
		traceId: row.trace_id,
		runId: row.run_id ?? undefined,
		repo: row.repo ?? undefined,
		subject: row.subject ?? undefined,
		type: row.type,
		payload: row.payload,
		createdAt: row.created_at,
	};
}

/** Ends the pool so scripts can exit. */
export async function closeEvents(): Promise<void> {
	const p = pool;
	pool = undefined;
	await p?.end();
}
