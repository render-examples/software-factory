import type { ThreadKey } from "../threads/index.js";
import type { Queryable } from "./pool.js";

export interface LogEvent {
	seq: number;
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

export interface ThreadCursor {
	tx: string;
	seq: number;
}

export const EVENT_COLUMNS = `seq, tx::text as tx, stream, stream_version as "streamVersion", thread, type, version, source, payload, created_at as "createdAt"`;

export function toEvent(row: LogEvent): LogEvent {
	return { ...row, seq: Number(row.seq) };
}

export async function readStream(db: Queryable, stream: string, afterVersion: number, limit = 500): Promise<LogEvent[]> {
	const { rows } = await db.query<LogEvent>(
		`select ${EVENT_COLUMNS} from events where stream = $1 and stream_version > $2 order by stream_version limit $3`,
		[stream, afterVersion, limit],
	);
	return rows.map(toEvent);
}

export async function readThread(db: Queryable, thread: ThreadKey, after: ThreadCursor, limit = 500): Promise<LogEvent[]> {
	const { rows } = await db.query<LogEvent>(
		`select ${EVENT_COLUMNS} from events
		 where thread = $1 and (tx, seq) > ($2::xid8, $3::bigint) and tx < pg_snapshot_xmin(pg_current_snapshot())
		 order by tx, seq limit $4`,
		[thread, after.tx, after.seq, limit],
	);
	return rows.map(toEvent);
}
