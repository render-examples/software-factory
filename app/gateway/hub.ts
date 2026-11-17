import pg from "pg";
import { LIVE_CHANNEL, LiveNotice } from "../events/index.js";
import { type Delta, LiveCache, type PartialMessage } from "./live.js";

/** Subscribes to commits on every stream. The `events` channel names only the stream, so subject readers use it. */
export const ANY_STREAM = "*";
const RECONNECT_MS = 5_000;

/**
 * Fans this instance's Postgres notifications out to its stream readers: `events` says a stream has new rows,
 * which readers fetch from their own cursors; `live` carries deltas, folded into the cache of partial messages.
 */
export class EventHub {
	readonly #events = new Map<string, Set<() => void>>();
	readonly #deltas = new Map<string, Set<(delta: Delta) => void>>();
	readonly #cache = new LiveCache();

	/** Calls `listener` when an event on `stream` (or any stream, for ANY_STREAM) commits. Returns an unsubscribe. */
	onEvents(stream: string, listener: () => void): () => void {
		return add(this.#events, stream, listener);
	}

	/** Calls `listener` with each new delta on a stream or subject. Returns an unsubscribe. */
	onDelta(key: string, listener: (delta: Delta) => void): () => void {
		return add(this.#deltas, key, listener);
	}

	partials(key: string): PartialMessage[] {
		return this.#cache.partials(key);
	}

	/** Handles one notification from the database. */
	receive(channel: string, payload: string): void {
		if (channel === LIVE_CHANNEL) {
			this.#receiveLive(payload);
			return;
		}
		const stream = payload.split(" ")[0] ?? "";
		for (const listener of [...(this.#events.get(stream) ?? []), ...(this.#events.get(ANY_STREAM) ?? [])]) listener();
	}

	#receiveLive(payload: string): void {
		let notice: LiveNotice;
		try {
			notice = LiveNotice.parse(JSON.parse(payload));
		} catch {
			return;
		}
		const delta = this.#cache.apply(notice);
		if (!delta) return;
		const bySubject = delta.subject ? this.#deltas.get(delta.subject) : undefined;
		for (const listener of [...(this.#deltas.get(delta.stream) ?? []), ...(bySubject ?? [])]) listener(delta);
	}
}

/**
 * Holds one LISTEN connection for `events` and `live`, and reconnects after it fails. Readers' polls cover the
 * events missed meanwhile; deltas missed meanwhile are lost.
 */
export function listen(hub: EventHub, connectionString: string): { stop(): Promise<void> } {
	let stopped = false;
	let client: pg.Client | undefined;
	let retry: NodeJS.Timeout | undefined;
	const connect = () => {
		const next = new pg.Client({ connectionString });
		client = next;
		let failed = false;
		const fail = (error: Error) => {
			if (failed || stopped) return;
			failed = true;
			console.error(JSON.stringify({ level: "warn", msg: "event listener disconnected; reconnecting", error: error.message }));
			void next.end().catch(() => {});
			retry = setTimeout(connect, RECONNECT_MS);
		};
		next.on("error", fail);
		next.on("end", () => fail(new Error("connection ended")));
		next.on("notification", ({ channel, payload }) => hub.receive(channel, payload ?? ""));
		next
			.connect()
			.then(() => next.query(`listen events; listen ${LIVE_CHANNEL}`))
			.catch(fail);
	};
	connect();
	return {
		async stop() {
			stopped = true;
			clearTimeout(retry);
			await client?.end().catch(() => {});
		},
	};
}

function add<T>(map: Map<string, Set<T>>, key: string, value: T): () => void {
	const set = map.get(key) ?? new Set();
	map.set(key, set);
	set.add(value);
	return () => {
		set.delete(value);
		if (!set.size) map.delete(key);
	};
}
