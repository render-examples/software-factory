import type { ThreadKey } from "../threads/index.js";
import type { Queryable } from "./pool.js";

export interface LogEvent {
	/** Assigned at insert. Transactions commit out of order, so never page by `seq` alone. */
	seq: number;
	/** The writing transaction's ID, as a decimal string. */
	tx: string;
	stream: string;
	streamVersion: number;
	thread: ThreadKey | null;
	type: string;
	version: number;
	source: string;
	payload: unknown;
	createdAt: Date;
}

/** A position in a thread's events. Start from `{ tx: "0", seq: 0 }`. */
export interface ThreadCursor {
	tx: string;
	seq: number;
}

export const EVENT_COLUMNS = `seq, tx::text as tx, stream, stream_version as "streamVersion", thread, type, version, source, payload, created_at as "createdAt"`;

/** `pg` returns bigint columns as strings and PGlite as numbers; `seq` stays far below 2^53. */
export function toEvent(row: LogEvent): LogEvent {
	return { ...row, seq: Number(row.seq) };
}

/** A stream's events after `afterVersion`, in order. A version is appended only once the previous one is visible, so this never skips one. */
export async function readStream(db: Queryable, stream: string, afterVersion: number, limit = 500): Promise<LogEvent[]> {
	const { rows } = await db.query<LogEvent>(
		`select ${EVENT_COLUMNS} from events where stream = $1 and stream_version > $2 order by stream_version limit $3`,
		[stream, afterVersion, limit],
	);
	return rows.map(toEvent);
}

/**
 * Every stream's events on a thread after the cursor, in (tx, seq) order. Only transactions older than every
 * running one are read: they have all finished, and new ones get higher IDs, so nothing can later appear behind
 * the cursor. A long transaction holds readers back until it ends. Read outside a writing transaction: its own
 * running ID would hide its own events and every later one.
 */
export async function readThread(db: Queryable, thread: ThreadKey, after: ThreadCursor, limit = 500): Promise<LogEvent[]> {
	const { rows } = await db.query<LogEvent>(
		`select ${EVENT_COLUMNS} from events
		 where thread = $1 and (tx, seq) > ($2::xid8, $3::bigint) and tx < pg_snapshot_xmin(pg_current_snapshot())
		 order by tx, seq limit $4`,
		[thread, after.tx, after.seq, limit],
	);
	return rows.map(toEvent);
}
