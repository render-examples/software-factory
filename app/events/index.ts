import pg from "pg";
import type { FactoryEvent, RunClaim, RunClaimInput } from "./types.js";

export type { FactoryEvent, RunClaim, RunClaimInput } from "./types.js";

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

/**
 * Appends the authoritative ownership claim for a stage run. Unlike telemetry `emit`, this is strict:
 * a run must not proceed when Postgres cannot order it against competing runs.
 */
export async function claimRun(input: RunClaimInput): Promise<RunClaim> {
	const { rows } = await requireDb().query<{ id: string }>(
		`insert into events (trace_id, run_id, repo, subject, type, payload)
		values ($1, $2, $3, $4, 'run.claimed', $5)
		returning id::text as id`,
		[input.traceId, input.runId, input.repo, input.subject, JSON.stringify({ stage: input.stage, actor: input.actor })],
	);
	const id = rows[0]?.id;
	if (!id) throw new Error("run claim insert returned no event id");
	return { id, runId: input.runId, repo: input.repo, subject: input.subject };
}

/** Whether `claim` is still the newest durable claim for its issue or PR. Fails closed on database errors. */
export async function isCurrentRun(claim: RunClaim): Promise<boolean> {
	const { rows } = await requireDb().query<{ id: string }>(
		`select id::text as id
		from events
		where repo = $1 and subject = $2 and type = 'run.claimed'
		order by events.id desc
		limit 1`,
		[claim.repo, claim.subject],
	);
	return rows[0]?.id === claim.id;
}

/** Ends the pool so scripts can exit. */
export async function closeEvents(): Promise<void> {
	const p = pool;
	pool = undefined;
	await p?.end();
}
