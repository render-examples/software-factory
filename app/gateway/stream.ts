import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type Db, type LogEvent, readStream, readThread } from "../db/index.js";
import { agentRunFinished, assistantMessage } from "../events/index.js";
import { githubThread, ThreadKey } from "../threads/index.js";
import { ANY_STREAM, type EventHub } from "./hub.js";
import { threadState } from "./state.js";

export interface StreamDeps {
	db: Db;
	hub: EventHub;
	eventsReadToken: string;
}

const PAGE = 500;
/** A backstop for a missed notification: it costs latency, never an event. */
const POLL_MS = 5_000;
/** A comment line this often keeps proxies from closing an idle connection. */
const KEEPALIVE_MS = 15_000;

const AgentRunParams = z.object({ id: z.string().regex(/^ar_[0-9a-f-]{36}$/) });
const name = z.string().regex(/^[\w.-]{1,100}$/);
const GitHubThreadParams = z.object({ owner: name, repo: name, kind: z.enum(["issue", "pr"]), number: z.string().regex(/^[1-9]\d{0,9}$/) });

/** Requires `Authorization: Bearer <token>`. Digests make the comparison constant-time whatever the lengths. */
export function requireReader(token: string): MiddlewareHandler {
	const expected = digest(token);
	return async (c, next) => {
		const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
		if (!given || !timingSafeEqual(digest(given), expected)) return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
		await next();
	};
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** One agent run's events; the SSE ID is the stream version. Ends after `agent_run.finished`. */
export function agentRunStream({ db, hub }: StreamDeps): Handler {
	return (c) => {
		const params = AgentRunParams.safeParse(c.req.param());
		const after = cursor(c, /^(\d{1,10})$/);
		if (!params.success || !after) return c.json({ error: "invalid agent run ID or cursor" }, 400);
		const stream = `agent_run:${params.data.id}`;
		let version = Number(after[1] ?? 0);
		return serve(c, hub, {
			key: stream,
			wakeOn: stream,
			async read() {
				const events = await readStream(db, stream, version, PAGE);
				version = events.at(-1)?.streamVersion ?? version;
				return events.map((event) => ({ id: String(event.streamVersion), event }));
			},
			ends: (event) => event.type === agentRunFinished.type,
		});
	};
}

/** Every event on a thread, from every stream; `:thread` is the URL-encoded thread key. */
export function threadStream(deps: StreamDeps): Handler {
	return (c) => {
		const thread = ThreadKey.safeParse(c.req.param("thread"));
		return serveThread(c, deps, thread.success ? thread.data : null);
	};
}

/** `threadStream` for a GitHub issue or pull request, addressed by its repository, kind, and number. */
export function githubThreadStream(deps: StreamDeps): Handler {
	return (c) => {
		const params = GitHubThreadParams.safeParse(c.req.param());
		if (!params.success) return serveThread(c, deps, null);
		const { owner, repo, kind, number } = params.data;
		return serveThread(c, deps, githubThread(`${owner}/${repo}`, { kind, number: Number(number) }));
	};
}

/** The SSE ID is `<tx>-<seq>`. Never ends. A linked thread, such as a factory pull request, streams the thread it links to. */
async function serveThread(c: Context, { db, hub }: StreamDeps, requested: ThreadKey | null): Promise<Response> {
	const after = cursor(c, /^(\d{1,20})-(\d{1,15})$/);
	if (!requested || !after) return c.json({ error: "invalid thread or cursor" }, 400);
	const thread = (await threadState(db, requested)).linked ?? requested;
	let position = { tx: after[1] ?? "0", seq: Number(after[2] ?? 0) };
	return serve(c, hub, {
		key: thread,
		wakeOn: ANY_STREAM,
		async read() {
			const events = await readThread(db, thread, position, PAGE);
			const last = events.at(-1);
			if (last) position = { tx: last.tx, seq: last.seq };
			return events.map((event) => ({ id: `${event.tx}-${event.seq}`, event }));
		},
	});
}

/** `Last-Event-ID`, else `?after=`, matched against `pattern`; an empty match when neither is set, null when invalid. */
function cursor(c: Context, pattern: RegExp): string[] | null {
	const value = c.req.header("last-event-id") ?? c.req.query("after");
	return value === undefined ? [] : pattern.exec(value);
}

interface Feed {
	/** The stream or thread that live deltas and partial messages are keyed by. */
	key: string;
	/** The stream whose commits wake the reader, or ANY_STREAM. */
	wakeOn: string;
	/** The next page after the feed's cursor, which it advances. */
	read(): Promise<{ id: string; event: LogEvent }[]>;
	ends?(event: LogEvent): boolean;
}

/**
 * Sends the stored backlog after the cursor, then a `live.partial` per in-progress message, then new events as
 * they commit and `live.delta`s as they arrive. Deltas carry no SSE ID, so `Last-Event-ID` stays a log cursor.
 */
function serve(c: Context, hub: EventHub, feed: Feed): Response {
	return streamSSE(c, async (sse) => {
		let disconnect = () => {};
		const closed = new Promise<void>((resolve) => {
			disconnect = resolve;
			sse.onAbort(resolve);
		});
		// Every write goes through one chain, so events, partials, and deltas reach the client in order. A failed
		// write or read ends the connection; the client resumes from its last event ID.
		let chain = Promise.resolve();
		const enqueue = (work: () => Promise<void>) => {
			chain = chain.then(work).catch(disconnect);
		};

		let done = false;
		/** Messages whose final text this client already has, so a partial the cache hasn't dropped yet isn't sent. */
		const finished = new Set<string>();
		const drain = async () => {
			for (let page = await feed.read(); !done; page = await feed.read()) {
				for (const { id, event } of page) {
					await sse.writeSSE({ id, event: event.type, data: JSON.stringify(event) });
					if (event.type === assistantMessage.type) finished.add(`${event.stream} ${assistantMessage.payload.parse(event.payload).message_id}`);
					if (feed.ends?.(event)) {
						done = true;
						disconnect();
					}
				}
				if (page.length < PAGE) return;
			}
		};
		let woken = false;
		const wake = () => {
			if (woken || done) return;
			woken = true;
			enqueue(async () => {
				woken = false;
				await drain();
			});
		};

		let live = false;
		const unsubscribe = hub.onEvents(feed.wakeOn, wake);
		const unsubscribeDeltas = hub.onDelta(feed.key, ({ stream, thread, message_id, text }) => {
			if (live) enqueue(() => sse.writeSSE({ event: "live.delta", data: JSON.stringify({ stream, thread, message_id, text }) }));
		});
		const poll = setInterval(wake, POLL_MS);
		const keepalive = setInterval(() => enqueue(() => sse.write(": keepalive\n\n").then(() => {})), KEEPALIVE_MS);
		try {
			wake();
			enqueue(async () => {
				if (done) return;
				// Deltas that arrived before now are in the snapshot; later ones are queued behind it.
				live = true;
				for (const partial of hub.partials(feed.key)) {
					if (!finished.has(`${partial.stream} ${partial.message_id}`)) await sse.writeSSE({ event: "live.partial", data: JSON.stringify(partial) });
				}
			});
			await closed;
		} finally {
			clearInterval(poll);
			clearInterval(keepalive);
			unsubscribe();
			unsubscribeDeltas();
		}
	});
}
