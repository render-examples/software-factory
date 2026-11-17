import { claimAcquired, claimReleased, runFinished, runProgress, runRejected, runSandboxAttached, runStarted, runStopped } from "../events/index.js";
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
		const close = (state: string, outcome: string, summary: string, links: readonly unknown[] = []) =>
			tx.query(
				`update runs set state = $2, outcome = $3, summary = $4, links = $5::jsonb, finished_at = $6, updated_seq = $7
				 where run_id = $1 and state = 'running'`,
				[runId, state, outcome, summary, JSON.stringify(links), event.createdAt, event.seq],
			);
		switch (event.type) {
			case runStarted.type: {
				const { trace_id, task, title } = runStarted.payload.parse(event.payload);
				await tx.query(
					`insert into runs (run_id, trace_id, task, title, subject, state, started_at, updated_seq)
					 values ($1, $2, $3, $4, $5, 'running', $6, $7)`,
					[runId, trace_id, task, title, event.subject, event.createdAt, event.seq],
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
			case runRejected.type: {
				await close("rejected", "permission_denied", runRejected.payload.parse(event.payload).reason);
				return;
			}
			case runStopped.type: {
				const { outcome, summary } = runStopped.payload.parse(event.payload);
				await close("cancelled", outcome, summary);
				return;
			}
			case runFinished.type: {
				const { state, outcome, summary, links } = runFinished.payload.parse(event.payload);
				await close(state, outcome, summary, links);
				return;
			}
		}
	},
};

/** Which trace holds each subject, and the subject stream's version at its latest claim event. */
const claims: Projection = {
	table: "claims",
	key: ["subject"],
	operational: ["status_comment_id"],
	async apply(tx, event) {
		if (event.type === claimAcquired.type) {
			const { trace_id, run_id } = claimAcquired.payload.parse(event.payload);
			await tx.query(
				`insert into claims (subject, stream_version, trace_id, run_id, state, updated_seq) values ($1, $2, $3, $4, 'held', $5)
				 on conflict (subject) do update set stream_version = excluded.stream_version, trace_id = excluded.trace_id,
				   run_id = excluded.run_id, state = 'held', updated_seq = excluded.updated_seq`,
				[event.subject, event.streamVersion, trace_id, run_id, event.seq],
			);
		} else if (event.type === claimReleased.type) {
			await tx.query("update claims set stream_version = $2, state = 'released', updated_seq = $3 where subject = $1", [
				event.subject,
				event.streamVersion,
				event.seq,
			]);
		}
	},
};

export const PROJECTIONS: readonly Projection[] = [runs, claims, agentRuns];

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
