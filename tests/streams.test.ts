import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { append, type Db } from "../app/db/index.js";
import { type AgentRunSummary, AgentRunRecorder, defineEvent } from "../app/events/index.js";
import { createGateway, EventHub } from "../app/gateway/index.js";
import type { RunnerEvent } from "../app/runner/core/protocol.js";
import type { ThreadKey } from "../app/threads/index.js";
import { pgliteDb } from "./helpers/db.js";
import { readSse } from "./helpers/sse.js";

const TOKEN = "reader-token";
const THREAD = "github:acme/web#issue-12";
const THREAD_PATH = "/threads/github/acme/web/issue/12/stream";
const at = new Date().toISOString();
const SUMMARY: AgentRunSummary = {
	outcome: "ok",
	turns: 1,
	usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 },
	costUsd: 0,
};
const claimed = defineEvent("test.claimed", 1, z.strictObject({ run_id: z.string().max(50) }));
const progressed = defineEvent("test.progressed", 1, z.strictObject({ summary: z.string().max(100) }));

let db: Db;
let pglite: PGlite;
let hub: EventHub;
let app: ReturnType<typeof createGateway>;
beforeAll(async () => {
	({ db, pglite } = await pgliteDb());
	hub = new EventHub();
	for (const channel of ["events", "live"]) await pglite.listen(channel, (payload) => hub.receive(channel, payload));
	app = createGateway({ startTask: async () => ({ id: "trn" }), webhookSecret: "secret", db, hub, eventsReadToken: TOKEN });
});
afterAll(() => db.end());

const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
const feed = (r: AgentRunRecorder, ...events: RunnerEvent[]) => {
	for (const event of events) r.onRunnerEvent(event);
};
const delta = (text: string, message_id: string): RunnerEvent => ({ type: "assistant_delta", at, message_id, text });
const text = (text: string, message_id: string): RunnerEvent => ({ type: "assistant_text", at, message_id, text });

function startRun(thread: ThreadKey = THREAD): AgentRunRecorder {
	const r = new AgentRunRecorder({ db, runId: "trn-1", thread });
	r.start({ agentId: "triage", harness: "pi", model: "anthropic/claude-opus-5" });
	return r;
}

describe("stream authentication", () => {
	it.each([
		["no header", {}],
		["a wrong token", { authorization: "Bearer not-the-token" }],
		["another scheme", { authorization: `Basic ${TOKEN}` }],
	])("rejects a request with %s", async (_, headers) => {
		for (const path of ["/agent-runs/ar_00000000-0000-0000-0000-000000000000/stream", THREAD_PATH]) {
			const res = await app.request(path, { headers });
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe("Bearer");
		}
	});

	it("rejects malformed IDs, threads, and cursors before streaming", async () => {
		expect((await get("/agent-runs/run-1/stream")).status).toBe(400);
		expect((await get("/threads/github/acme/web/discussion/12/stream")).status).toBe(400);
		expect((await get(`/threads/${encodeURIComponent("acme/web#issue-12")}/stream`)).status).toBe(400);
		expect((await get(`/threads/${encodeURIComponent("GitHub:acme/web#issue-12")}/stream`)).status).toBe(400);
		expect((await get(THREAD_PATH, { "last-event-id": "12" })).status).toBe(400);
		expect((await get("/agent-runs/ar_00000000-0000-0000-0000-000000000000/stream?after=1-2")).status).toBe(400);
	});
});

describe("GET /agent-runs/:id/stream", () => {
	it("sends the backlog, then each in-progress message so far, then live deltas and events, and ends after agent_run.finished", async () => {
		const r = startRun();
		feed(r, delta("Hel", "m1"), delta("lo", "m1"), text("Hello", "m1"), delta("Work", "m2"));
		await vi.waitFor(() => expect(hub.partials(r.stream)).toEqual([expect.objectContaining({ message_id: "m2", text: "Work" })]), { timeout: 2000 });

		const stream = readSse(await get(`/agent-runs/${r.id}/stream`));
		expect(await stream.take(3)).toEqual([
			{ event: "agent_run.started", id: "1", data: expect.objectContaining({ stream: r.stream, streamVersion: 1 }) },
			{ event: "assistant.message", id: "2", data: expect.objectContaining({ payload: { message_id: "m1", text: "Hello" } }) },
			{ event: "live.partial", id: undefined, data: { stream: r.stream, thread: THREAD, message_id: "m2", text: "Work" } },
		]);

		feed(r, delta("ing", "m2"));
		expect(await stream.next()).toEqual({
			event: "live.delta",
			id: undefined,
			data: { stream: r.stream, thread: THREAD, message_id: "m2", text: "ing" },
		});

		feed(r, text("Working", "m2"));
		await r.finish(SUMMARY);
		expect((await stream.take(3)).map((f) => [f.event, f.id])).toEqual([
			["assistant.message", "3"],
			["agent_run.finished", "4"],
		]);
		expect(hub.partials(r.stream)).toEqual([]);
	});

	it("resumes after Last-Event-ID, or ?after=, and replays a finished run with final messages only", async () => {
		const r = startRun();
		feed(r, delta("Hi", "m1"), text("Hi", "m1"), { type: "tool_call", at, tool_call_id: "c1", tool: "ls", args: {} });
		await r.finish(SUMMARY);
		const resumes: [string, Record<string, string>][] = [
			[`/agent-runs/${r.id}/stream`, { "last-event-id": "2" }],
			[`/agent-runs/${r.id}/stream?after=2`, {}],
		];
		for (const [path, headers] of resumes) {
			const frames = await readSse(await get(path, headers)).take(10);
			expect(frames.map((f) => [f.event, f.id])).toEqual([
				["tool.call", "3"],
				["agent_run.finished", "4"],
			]);
		}
	});
});

describe("GET /threads/:thread/stream", () => {
	it("shows every stream's events on the thread in commit order, with live deltas, and resumes from a <tx>-<seq> ID", async () => {
		const thread = "github:acme/web#issue-77";
		const path = `/threads/${encodeURIComponent(thread)}/stream`;
		await db.withTx((tx) =>
			append(tx, { type: claimed, stream: `thread:${thread}`, thread, source: "workflow:trn-1", payload: { run_id: "trn-1" } }),
		);
		await db.withTx((tx) =>
			append(tx, { type: progressed, stream: "run:trn-1", thread, source: "workflow:trn-1", payload: { summary: "triaging" } }),
		);
		await db.withTx((tx) =>
			append(tx, {
				type: progressed,
				stream: "run:trn-2",
				thread: "github:acme/web#issue-78",
				source: "workflow:trn-2",
				payload: { summary: "other" },
			}),
		);
		const r = startRun(thread);
		feed(r, text("Reading the issue.", "m1"));
		await vi.waitFor(async () => expect((await db.query("select 1 from events where stream = $1", [r.stream])).rows).toHaveLength(2), {
			timeout: 2000,
		});

		const stream = readSse(await get(path));
		const backlog = await stream.take(4);
		expect(backlog.map((f) => f.event)).toEqual(["test.claimed", "test.progressed", "agent_run.started", "assistant.message"]);
		for (const frame of backlog) expect(frame.id).toMatch(/^\d+-\d+$/);

		feed(r, delta("Draft", "m2"));
		expect(await stream.next()).toEqual({ event: "live.delta", id: undefined, data: { stream: r.stream, thread, message_id: "m2", text: "Draft" } });
		await r.finish(SUMMARY);
		expect((await stream.next())?.event).toBe("agent_run.finished");
		await stream.close();

		const resumed = readSse(await get(path, { "last-event-id": backlog[1]?.id as string }));
		expect((await resumed.take(3)).map((f) => f.event)).toEqual(["agent_run.started", "assistant.message", "agent_run.finished"]);
		await resumed.close();
	});

	it("serves a GitHub issue or pull request at its alias path, the same as at its thread key", async () => {
		const thread = "github:acme/web#pr-34";
		await db.withTx((tx) =>
			append(tx, { type: claimed, stream: `thread:${thread}`, thread, source: "workflow:trn-3", payload: { run_id: "trn-3" } }),
		);
		const frames = [];
		for (const path of [`/threads/${encodeURIComponent(thread)}/stream`, "/threads/github/acme/web/pr/34/stream"]) {
			const stream = readSse(await get(path));
			frames.push(await stream.take(1));
			await stream.close();
		}
		expect(frames[0]).toEqual([expect.objectContaining({ event: "test.claimed", data: expect.objectContaining({ thread }) })]);
		expect(frames[1]).toEqual(frames[0]);
	});
});
