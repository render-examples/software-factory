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

export const PROJECTIONS: readonly Projection[] = [agentRuns];

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
