import type { z } from "zod";
import type { EventSpec } from "../events/index.js";
import { ThreadKey } from "../threads/index.js";
import type { Tx } from "./pool.js";
import { project } from "./projections.js";
import { EVENT_COLUMNS, type LogEvent, toEvent } from "./read.js";

/** An event payload's largest JSON encoding, in UTF-8 bytes. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export interface NewEvent<S extends z.ZodType = z.ZodType> {
	type: EventSpec<S>;
	stream: string;
	/** Set on every event about a thread, whatever its stream. */
	thread?: ThreadKey;
	/** "github", "gateway", or "workflow:<run_id>". Nothing in a Sandbox writes events. */
	source: string;
	payload: z.input<NoInfer<S>>;
	idempotencyKey?: string;
}

export interface AppendOptions {
	/** Fails with VersionConflict unless the stream is at exactly this version (0 for a new stream). */
	expectedVersion?: number;
}

/**
 * The stream wasn't at the expected version, or a concurrent append took the same version. A collision aborts the
 * transaction, so retry, if at all, in a new one.
 */
export class VersionConflict extends Error {
	override readonly name = "VersionConflict";
	constructor(readonly stream: string) {
		super(`stream ${stream} is not at the expected version`);
	}
}

const INSERT = `
	insert into events (stream, stream_version, thread, type, version, source, idempotency_key, payload)
	select $1::text, coalesce(max(stream_version), 0) + 1, $2::text, $3::text, $4::int, $5::text, $6::text, $7::jsonb
	from events where stream = $1::text
	having $8::int is null or coalesce(max(stream_version), 0) = $8::int
	on conflict (idempotency_key) do nothing
	returning ${EVENT_COLUMNS}`;

/**
 * Appends one event at the stream's next version, applies projections, and notifies `events` listeners with
 * "<stream> <stream_version>", all in the caller's transaction, so listeners hear only of committed events.
 * A repeated idempotency key returns null and changes nothing. Keep the transaction short: it holds back
 * cross-stream readers until it ends.
 */
export async function append<S extends z.ZodType>(tx: Tx, event: NewEvent<S>, { expectedVersion }: AppendOptions = {}): Promise<LogEvent | null> {
	const payload = JSON.stringify(event.type.payload.parse(event.payload));
	if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new Error(`${event.type.type} payload is larger than 256 KB`);
	if (event.thread !== undefined && !ThreadKey.safeParse(event.thread).success) throw new Error(`${event.type.type} has an invalid thread key`);
	let rows: LogEvent[];
	try {
		({ rows } = await tx.query<LogEvent>(INSERT, [
			event.stream,
			event.thread ?? null,
			event.type.type,
			event.type.version,
			event.source,
			event.idempotencyKey ?? null,
			payload,
			expectedVersion ?? null,
		]));
	} catch (error) {
		if ((error as { code?: string }).code === "23505") throw new VersionConflict(event.stream);
		throw error;
	}
	const [row] = rows;
	if (!row) {
		if (event.idempotencyKey && (await tx.query("select 1 from events where idempotency_key = $1", [event.idempotencyKey])).rows.length) return null;
		throw new VersionConflict(event.stream);
	}
	const logged = toEvent(row);
	await project(tx, logged);
	await tx.query("select pg_notify('events', $1)", [`${logged.stream} ${logged.streamVersion}`]);
	return logged;
}

/** Appends events to one stream in order, as `append` does, and returns those not skipped as repeats. */
export async function appendMany(
	tx: Tx,
	stream: string,
	events: readonly Omit<NewEvent, "stream">[],
	options: AppendOptions = {},
): Promise<LogEvent[]> {
	const appended: LogEvent[] = [];
	let { expectedVersion } = options;
	for (const event of events) {
		const logged = await append(tx, { ...event, stream }, { expectedVersion });
		if (!logged) continue;
		appended.push(logged);
		expectedVersion = logged.streamVersion;
	}
	return appended;
}
