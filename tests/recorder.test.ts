import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRunRecorder, type AgentRunSummary } from "../app/agent-runs/index.js";
import { type Db, readStream } from "../app/db/index.js";
import { LiveNotice } from "../app/events/index.js";
import type { RunnerEvent } from "../app/runner/core/protocol.js";
import type { ThreadKey } from "../app/threads/index.js";
import { pgliteDb } from "./helpers/db.js";

let db: Db;
let pglite: PGlite;
const notices: LiveNotice[] = [];
const payloadBytes: number[] = [];
beforeAll(async () => {
	({ db, pglite } = await pgliteDb());
	await pglite.listen("live", (payload) => {
		payloadBytes.push(Buffer.byteLength(payload));
		notices.push(LiveNotice.parse(JSON.parse(payload)));
	});
});
afterAll(() => db.end());
afterEach(() => {
	notices.length = 0;
	payloadBytes.length = 0;
	vi.restoreAllMocks();
});

const at = new Date().toISOString();
const usage = (cost: number) => ({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: cost });
const SUMMARY: AgentRunSummary = { outcome: "ok", turns: 1, usage: usage(0.01), costUsd: 0.01 };

function recorder(database = db) {
	const r = new AgentRunRecorder({ db: database, runId: "trn-1", thread: "github:acme/web#issue-12" });
	r.start({ agentId: "triage", harness: "pi", model: "anthropic/claude-opus-5" });
	return r;
}
const feed = (r: AgentRunRecorder, ...events: RunnerEvent[]) => {
	for (const event of events) r.onRunnerEvent(event);
};
const delta = (text: string, message_id = "m1"): RunnerEvent => ({ type: "assistant_delta", at, message_id, text });
const logged = (r: AgentRunRecorder) => readStream(db, r.stream, 0);
const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;

/** A database whose first `failures` transactions fail. */
function flaky(failures: number): Db & { attempts: number } {
	const wrapper = {
		...db,
		attempts: 0,
		withTx<T>(fn: Parameters<Db["withTx"]>[0]): Promise<T> {
			return ++wrapper.attempts <= failures ? Promise.reject(new Error("connection refused")) : (db.withTx(fn) as Promise<T>);
		},
	};
	return wrapper;
}

describe("AgentRunRecorder", () => {
	it("translates runner events to log events on its own stream, and ignores started, result, and error", async () => {
		const r = recorder();
		feed(
			r,
			{ type: "started", at, agent_id: "evil", harness: "pi", harness_version: "1", model: "x" },
			{ type: "tool_call", at, tool_call_id: "c1", tool: "ls", args: { path: "." } },
			{ type: "tool_result", at, tool_call_id: "c1", tool: "ls", is_error: false, output_preview: "README.md" },
			{ type: "assistant_text", at, message_id: "m1", text: "Done." },
			{ type: "usage", at, usage: usage(0.01) },
			{ type: "result", at, output: {}, turns: 1 },
		);
		await r.finish(SUMMARY);
		const events = await logged(r);
		expect(events.map((e) => [e.type, e.payload])).toEqual([
			["agent_run.started", { run_id: "trn-1", agent_id: "triage", harness: "pi", model: "anthropic/claude-opus-5" }],
			["tool.call", { call_id: "c1", tool: "ls", args: '{"path":"."}' }],
			["tool.result", { call_id: "c1", tool: "ls", is_error: false, output_preview: "README.md" }],
			["assistant.message", { message_id: "m1", text: "Done." }],
			["usage", usage(0.01)],
			["agent_run.finished", { outcome: "ok", turns: 1, usage: usage(0.01), cost_usd: 0.01 }],
		]);
		expect(events.every((e) => e.thread === "github:acme/web#issue-12" && e.source === "workflow:trn-1")).toBe(true);
	});

	it("writes what arrives within 250 ms in one transaction, combining each message's deltas into one notification", async () => {
		const r = recorder();
		feed(r, delta("Hel"), delta("lo"), delta("Other", "m2"), delta(" world"), { type: "tool_call", at, tool_call_id: "c1", tool: "ls", args: {} });
		await vi.waitFor(async () => expect(await logged(r)).toHaveLength(2), { timeout: 2000 });
		expect(new Set((await logged(r)).map((e) => e.tx)).size).toBe(1);
		await vi.waitFor(() => expect(notices).toHaveLength(2));
		expect(notices).toEqual([
			{ type: "delta", stream: r.stream, thread: "github:acme/web#issue-12", message_id: "m1", local_seq: 1, part: 0, text: "Hello world" },
			{ type: "delta", stream: r.stream, thread: "github:acme/web#issue-12", message_id: "m2", local_seq: 2, part: 0, text: "Other" },
		]);

		feed(r, { type: "assistant_text", at, message_id: "m1", text: "Hello world" });
		await r.finish(SUMMARY);
		await vi.waitFor(() => expect(notices).toHaveLength(4));
		// m1's final follows its message into the log; m2 never finished, so finish() closes it.
		expect(notices.slice(2)).toEqual([
			{ type: "final", stream: r.stream, message_id: "m1" },
			{ type: "final", stream: r.stream, message_id: "m2" },
		]);
	});

	it("splits a long delta into parts that each fit a NOTIFY payload", async () => {
		const text = `${'"'.repeat(9000)}${"é".repeat(5000)}🙂`;
		const r = recorder();
		feed(r, delta(text));
		await r.finish(SUMMARY);
		const parts = notices.filter((n) => n.type === "delta");
		expect(parts.length).toBeGreaterThan(2);
		expect(parts.map((p) => p.part)).toEqual(parts.map((_, i) => i));
		expect(parts.map((p) => p.text).join("")).toBe(text);
		expect(Math.max(...payloadBytes)).toBeLessThan(8000);
	});

	it("strips NUL characters and unpaired surrogates, which Postgres rejects, and truncates long tool output", async () => {
		const r = recorder();
		feed(
			r,
			delta("a\u0000b"),
			{ type: "assistant_text", at, message_id: "m1", text: "a\u0000b \ud83d" },
			{ type: "tool_result", at, tool_call_id: "c1", tool: "bash", is_error: true, output_preview: `\u0000${"x".repeat(40_000)}` },
		);
		await r.finish(SUMMARY);
		const [, message, result] = await logged(r);
		expect(message?.payload).toEqual({ message_id: "m1", text: "ab \ufffd" });
		const preview = (result?.payload as { output_preview?: string } | undefined)?.output_preview ?? "";
		expect(jsonBytes(preview)).toBeLessThanOrEqual(32 * 1024);
		expect(jsonBytes(preview)).toBeGreaterThan(32 * 1024 - 8);
		expect(preview.startsWith("xxx")).toBe(true);
		expect(preview.endsWith("…[truncated]")).toBe(true);
		expect(notices[0]).toMatchObject({ type: "delta", text: "ab" });
	});

	it("clips by JSON-encoded bytes, so escape-heavy text can't block the events after it", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const r = recorder();
		// ESC is one character but six bytes in JSON: 60,000 of them are about 360 KB, over the 256 KB payload cap.
		feed(
			r,
			{ type: "assistant_text", at, message_id: "m1", text: "\u001b".repeat(60_000) },
			{ type: "tool_call", at, tool_call_id: "c1", tool: "bash", args: { command: "\u001b".repeat(40_000) } },
			{ type: "tool_result", at, tool_call_id: "c1", tool: "bash", is_error: false, output_preview: "ok" },
		);
		await r.finish(SUMMARY);
		const events = await logged(r);
		expect(events.map((e) => e.type)).toEqual(["agent_run.started", "assistant.message", "tool.call", "tool.result", "agent_run.finished"]);
		const text = (events[1]?.payload as { text: string } | undefined)?.text ?? "";
		const args = (events[2]?.payload as { args: string } | undefined)?.args ?? "";
		expect(jsonBytes(text)).toBeLessThanOrEqual(64 * 1024);
		expect(text.endsWith("…[truncated]")).toBe(true);
		expect(jsonBytes(args)).toBeLessThanOrEqual(32 * 1024);
		expect(warn).not.toHaveBeenCalled();
	});

	it("cuts multi-byte text at a character boundary within the budget", async () => {
		const r = recorder();
		feed(r, { type: "assistant_text", at, message_id: "m1", text: `${"字".repeat(20_000)}${"🙂".repeat(20_000)}` });
		await r.finish(SUMMARY);
		const text = ((await logged(r))[1]?.payload as { text: string } | undefined)?.text ?? "";
		expect(jsonBytes(text)).toBeLessThanOrEqual(64 * 1024);
		const kept = text.slice(0, -"…[truncated]".length);
		expect(kept).toMatch(/^字+🙂*$/u);
		expect(kept.at(-1)).not.toMatch(/[\ud800-\udbff]/);
	});

	it("records a run whose thread key is malformed, without the thread", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const r = new AgentRunRecorder({ db, runId: "trn-1", thread: "not a key" as ThreadKey });
		r.start({ agentId: "triage", harness: "pi", model: "anthropic/claude-opus-5" });
		feed(r, { type: "assistant_text", at, message_id: "m1", text: "Done." });
		await r.finish(SUMMARY);
		const events = await logged(r);
		expect(events.map((e) => [e.type, e.thread])).toEqual([
			["agent_run.started", null],
			["assistant.message", null],
			["agent_run.finished", null],
		]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("takes agent_run.finished from the host's summary, not from streamed usage", async () => {
		const r = recorder();
		feed(r, { type: "usage", at, usage: usage(5) }, { type: "usage", at, usage: usage(7) });
		await r.finish({ ...SUMMARY, outcome: "max_turns", message: "turn limit (1) reached" });
		expect((await logged(r)).at(-1)?.payload).toEqual({
			outcome: "max_turns",
			turns: 1,
			usage: usage(0.01),
			cost_usd: 0.01,
			message: "turn limit (1) reached",
		});
		const { rows } = await db.query<{ state: string; cost_usd: string }>("select state, cost_usd from agent_runs where id = $1", [r.id]);
		expect(rows.map((row) => [row.state, Number(row.cost_usd)])).toEqual([["max_turns", 0.01]]);
	});

	it("keeps buffering through a database error and writes everything once the database is back", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const database = flaky(1);
		const r = recorder(database);
		feed(r, { type: "tool_call", at, tool_call_id: "c1", tool: "ls", args: {} });
		await vi.waitFor(() => expect(database.attempts).toBeGreaterThanOrEqual(1), { timeout: 2000 });
		feed(r, { type: "tool_call", at, tool_call_id: "c2", tool: "ls", args: {} });
		await r.finish(SUMMARY);
		expect((await logged(r)).map((e) => e.type)).toEqual(["agent_run.started", "tool.call", "tool.call", "agent_run.finished"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent run events not recorded"));
	});

	it("bounds the queue while the database is down, dropping later events but never the outcome", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const database = flaky(1);
		const r = recorder(database);
		for (let i = 0; i < 1005; i++) feed(r, { type: "tool_call", at, tool_call_id: `c${i}`, tool: "ls", args: {} });
		await vi.waitFor(() => expect(database.attempts).toBeGreaterThanOrEqual(1), { timeout: 2000 });
		await r.finish(SUMMARY);
		const types = (await readStream(db, r.stream, 0, 2000)).map((e) => e.type);
		expect(types).toHaveLength(1001);
		expect(types.at(0)).toBe("agent_run.started");
		expect(types.at(-1)).toBe("agent_run.finished");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"dropped":6'));
	});

	it("keeps the outcome when a write fails with the queue full", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const database = flaky(2);
		const r = recorder(database);
		for (let i = 0; i < 1005; i++) feed(r, { type: "tool_call", at, tool_call_id: `c${i}`, tool: "ls", args: {} });
		await vi.waitFor(() => expect(database.attempts).toBeGreaterThanOrEqual(1), { timeout: 2000 });
		await r.finish(SUMMARY);
		expect((await logged(r)).map((e) => e.type)).toEqual(["agent_run.started", "agent_run.finished"]);
	});

	it("still records the outcome when the rest of the stream can't be written", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const database = flaky(2);
		const r = recorder(database);
		feed(r, { type: "assistant_text", at, message_id: "m1", text: "lost" });
		await vi.waitFor(() => expect(database.attempts).toBeGreaterThanOrEqual(1), { timeout: 2000 });
		await r.finish(SUMMARY);
		expect((await logged(r)).map((e) => e.type)).toEqual(["agent_run.started", "agent_run.finished"]);
	});
});
