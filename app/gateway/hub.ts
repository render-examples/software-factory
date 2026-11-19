import pg from "pg";
import { LIVE_CHANNEL, LiveNotice } from "../events/index.js";
import { type Delta, LiveCache, type PartialMessage } from "./live.js";

export const ANY_STREAM = "*";
const RECONNECT_MS = 5_000;

export class EventHub {
	readonly #events = new Map<string, Set<() => void>>();
	readonly #deltas = new Map<string, Set<(delta: Delta) => void>>();
	readonly #cache = new LiveCache();

	onEvents(stream: string, listener: () => void): () => void {
		return add(this.#events, stream, listener);
	}

	onDelta(key: string, listener: (delta: Delta) => void): () => void {
		return add(this.#deltas, key, listener);
	}

	partials(key: string): PartialMessage[] {
		return this.#cache.partials(key);
	}

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
		const byThread = delta.thread ? this.#deltas.get(delta.thread) : undefined;
		for (const listener of [...(this.#deltas.get(delta.stream) ?? []), ...(byThread ?? [])]) listener(delta);
	}
}

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
