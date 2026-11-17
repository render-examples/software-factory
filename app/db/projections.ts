import { runFinished, runProgress, runRejected, runSandboxAttached, runStarted, runStopped, threadLinked } from "../events/index.js";
import { agentRuns } from "./agent-runs.js";
import type { Db, Tx } from "./pool.js";
import { EVENT_COLUMNS, type LogEvent, toEvent } from "./read.js";

/** A table derived from the log. Each row records the `updated_seq` of the last event applied to it. */
export interface Projection {
	table: string;
	/** Columns that identify a row, so a rebuild can carry its operational columns over. */
	key: readonly string[];
	/** Operational metadata rather than derived state, such as a status comment's ID; marked in the migration too. */
	operational: readonly string[];
	/** Applies one event; ignores event types the projection doesn't derive from. */
	apply(tx: Tx, event: LogEvent): Promise<void>;
}

/** Each task run's state. Only a running row changes, so a run's own late events can't rewrite how it was stopped. */
const runs: Projection = {
	table: "runs",
	key: ["run_id"],
	operational: [],
	async apply(tx, event) {
		const runId = event.stream.slice("run:".length);
		const close = (state: string, outcome: string, summary: string, links: readonly unknown[] = [], waiting: string | null = null) =>
			tx.query(
				`update runs set state = $2, outcome = $3, summary = $4, links = $5::jsonb, waiting = $6, finished_at = $7, updated_seq = $8
				 where run_id = $1 and state = 'running'`,
				[runId, state, outcome, summary, JSON.stringify(links), waiting, event.createdAt, event.seq],
			);
		switch (event.type) {
			case runStarted.type: {
				const { run_id, trace_id, task, title } = runStarted.payload.parse(event.payload);
				await tx.query(
					`insert into runs (run_id, trace_id, task, title, thread, state, started_at, updated_seq)
					 values ($1, $2, $3, $4, $5, 'running', $6, $7)`,
					[run_id, trace_id, task, title, event.thread, event.createdAt, event.seq],
				);
				return;
			}
			case runRejected.type: {
				const { trace_id, task, title, reason } = runRejected.payload.parse(event.payload);
				await tx.query(
					`insert into runs (run_id, trace_id, task, title, thread, state, outcome, summary, links, started_at, finished_at, updated_seq)
					 values ($1, $2, $3, $4, $5, 'rejected', 'permission_denied', $6, '[]', $7, $7, $8)`,
					[runId, trace_id, task, title, event.thread, reason, event.createdAt, event.seq],
				);
				return;
			}
			case runProgress.type: {
				const { summary } = runProgress.payload.parse(event.payload);
				await tx.query("update runs set summary = $2, updated_seq = $3 where run_id = $1 and state = 'running'", [runId, summary, event.seq]);
				return;
			}
			case runSandboxAttached.type: {
				const { sandbox_id } = runSandboxAttached.payload.parse(event.payload);
				await tx.query("update runs set sandbox_id = $2, updated_seq = $3 where run_id = $1 and state = 'running'", [runId, sandbox_id, event.seq]);
				return;
			}
			case runStopped.type: {
				await close("cancelled", "superseded", runStopped.payload.parse(event.payload).summary);
				return;
			}
			case runFinished.type: {
				const { state, outcome, summary, links, waiting } = runFinished.payload.parse(event.payload);
				await close(state, outcome, summary, links, waiting);
				return;
			}
		}
	},
};

/** The latest run started on each thread. */
const threads: Projection = {
	table: "threads",
	key: ["thread"],
	operational: ["status_comment_id"],
	async apply(tx, event) {
		if (event.type !== runStarted.type) return;
		const { trace_id, run_id } = runStarted.payload.parse(event.payload);
		await tx.query(
			`insert into threads (thread, trace_id, run_id, updated_seq) values ($1, $2, $3, $4)
			 on conflict (thread) do update set trace_id = excluded.trace_id, run_id = excluded.run_id, updated_seq = excluded.updated_seq`,
			[event.thread, trace_id, run_id, event.seq],
		);
	},
};

/** Threads whose work runs on another thread. */
const threadLinks: Projection = {
	table: "thread_links",
	key: ["thread"],
	operational: [],
	async apply(tx, event) {
		if (event.type !== threadLinked.type) return;
		await tx.query(
			`insert into thread_links (thread, linked_to, updated_seq) values ($1, $2, $3)
			 on conflict (thread) do update set linked_to = excluded.linked_to, updated_seq = excluded.updated_seq`,
			[event.thread, threadLinked.payload.parse(event.payload).to, event.seq],
		);
	},
};

export const PROJECTIONS: readonly Projection[] = [runs, threads, threadLinks, agentRuns];

/** Applies an event to every projection, in the transaction that appends it. */
export async function project(tx: Tx, event: LogEvent): Promise<void> {
	for (const projection of PROJECTIONS) await projection.apply(tx, event);
}

/**
 * Truncates the projections, replays the whole log through them in `seq` order, and restores their operational
 * columns. Returns the number of events replayed. A projection that can't be rebuilt this way is a bug.
 */
export async function rebuild(db: Db, projections = PROJECTIONS): Promise<number> {
	return db.withTx(async (tx) => {
		// Waits for running appends and blocks new ones until the rebuild commits, so the replay sees the whole log.
		await tx.query("lock table events in share mode");
		for (const { table, key, operational } of projections) {
			if (operational.length) {
				await tx.query(`create temp table keep_${table} on commit drop as select ${[...key, ...operational].join(", ")} from ${table}`);
			}
		}
		if (projections.length) await tx.query(`truncate ${projections.map((p) => p.table).join(", ")}`);

		let replayed = 0;
		for (let after = 0; ; ) {
			const { rows } = await tx.query<LogEvent>(`select ${EVENT_COLUMNS} from events where seq > $1 order by seq limit 1000`, [after]);
			if (!rows.length) break;
			for (const event of rows.map(toEvent)) {
				for (const projection of projections) await projection.apply(tx, event);
				after = event.seq;
			}
			replayed += rows.length;
		}

		for (const { table, key, operational } of projections) {
			if (!operational.length) continue;
			const set = operational.map((column) => `${column} = keep.${column}`).join(", ");
			const match = key.map((column) => `${table}.${column} = keep.${column}`).join(" and ");
			await tx.query(`update ${table} set ${set} from keep_${table} keep where ${match}`);
		}
		return replayed;
	});
}
