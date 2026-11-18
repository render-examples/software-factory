import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { z } from "zod";
import { type Db, type LogEvent, readStream, readThread } from "../db/index.js";
import { agentRunFinished, assistantMessage } from "../events/index.js";
import { githubThread, ThreadKey } from "../threads/index.js";
import { ANY_STREAM, type EventHub } from "./hub.js";

export interface StreamDeps {
	db: Db;
	hub: EventHub;
	eventsReadToken: string;
}

const PAGE = 500;
const POLL_MS = 5_000;
const KEEPALIVE_MS = 15_000;

const AgentRunParams = z.object({ id: z.string().regex(/^ar_[0-9a-f-]{36}$/) });
const name = z.string().regex(/^[\w.-]{1,100}$/);
const GitHubThreadParams = z.object({ owner: name, repo: name, kind: z.enum(["issue", "pr"]), number: z.string().regex(/^[1-9]\d{0,9}$/) });

export function requireReader(token: string): MiddlewareHandler {
	const expected = digest(token);
	return async (c, next) => {
		const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
		if (!given || !timingSafeEqual(digest(given), expected)) return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
		await next();
	};
}

const digest = (value: string) => createHash("sha256").update(value).digest();

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

export function threadStream(deps: StreamDeps): Handler {
	return (c) => {
		const thread = ThreadKey.safeParse(c.req.param("thread"));
		return serveThread(c, deps, thread.success ? thread.data : null);
	};
}

export function githubThreadStream(deps: StreamDeps): Handler {
	return (c) => {
		const params = GitHubThreadParams.safeParse(c.req.param());
		if (!params.success) return serveThread(c, deps, null);
		const { owner, repo, kind, number } = params.data;
		return serveThread(c, deps, githubThread(`${owner}/${repo}`, { kind, number: Number(number) }));
	};
}

async function serveThread(c: Context, { db, hub }: StreamDeps, thread: ThreadKey | null): Promise<Response> {
	const after = cursor(c, /^(\d{1,20})-(\d{1,15})$/);
	if (!thread || !after) return c.json({ error: "invalid thread or cursor" }, 400);
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

function cursor(c: Context, pattern: RegExp): string[] | null {
	const value = c.req.header("last-event-id") ?? c.req.query("after");
	return value === undefined ? [] : pattern.exec(value);
}

interface Feed {
	key: string;
	wakeOn: string;
	read(): Promise<{ id: string; event: LogEvent }[]>;
	ends?(event: LogEvent): boolean;
}

function serve(c: Context, hub: EventHub, feed: Feed): Response {
	return streamSSE(c, async (sse) => {
		const queue = writeQueue(sse);
		let ended = false;
		const finished = new Set<string>();
		let live = false;

		const drainBacklog = async () => {
			for (let page = await feed.read(); !ended; page = await feed.read()) {
				for (const { id, event } of page) {
					await sse.writeSSE({ id, event: event.type, data: JSON.stringify(event) });
					if (event.type === assistantMessage.type) finished.add(`${event.stream} ${assistantMessage.payload.parse(event.payload).message_id}`);
					if (feed.ends?.(event)) {
						ended = true;
						queue.close();
					}
				}
				if (page.length < PAGE) return;
			}
		};

		const emitPartials = async () => {
			if (ended) return;
			live = true;
			for (const partial of hub.partials(feed.key)) {
				if (!finished.has(`${partial.stream} ${partial.message_id}`)) await sse.writeSSE({ event: "live.partial", data: JSON.stringify(partial) });
			}
		};

		let woken = false;
		const wake = () => {
			if (woken || ended) return;
			woken = true;
			queue.enqueue(async () => {
				woken = false;
				await drainBacklog();
			});
		};

		const unsubscribe = hub.onEvents(feed.wakeOn, wake);
		const unsubscribeDeltas = hub.onDelta(feed.key, ({ stream, thread, message_id, text }) => {
			if (live) queue.enqueue(() => sse.writeSSE({ event: "live.delta", data: JSON.stringify({ stream, thread, message_id, text }) }));
		});
		const poll = setInterval(wake, POLL_MS);
		const keepalive = setInterval(() => queue.enqueue(() => sse.write(": keepalive\n\n").then(() => {})), KEEPALIVE_MS);
		try {
			wake();
			queue.enqueue(emitPartials);
			await queue.closed;
		} finally {
			clearInterval(poll);
			clearInterval(keepalive);
			unsubscribe();
			unsubscribeDeltas();
		}
	});
}

function writeQueue(sse: SSEStreamingApi) {
	let close = () => {};
	const closed = new Promise<void>((resolve) => {
		close = resolve;
		sse.onAbort(resolve);
	});
	let chain = Promise.resolve();
	return {
		closed,
		close,
		enqueue(work: () => Promise<void>) {
			chain = chain.then(work).catch(close);
		},
	};
}
