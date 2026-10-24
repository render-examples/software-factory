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

/** Ends the pool so scripts can exit. */
export async function closeEvents(): Promise<void> {
	const p = pool;
	pool = undefined;
	await p?.end();
}
