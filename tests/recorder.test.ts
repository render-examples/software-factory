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
type Logged = Awaited<ReturnType<typeof logged>>;
const payloadOf = (events: Logged, type: string) => (events.find((e) => e.type === type)?.payload ?? {}) as Record<string, string | undefined>;
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

	it.each<{ name: string; events: RunnerEvent[]; check: (logged: Logged) => void }>([
		{
			name: "strips NUL characters and unpaired surrogates, which Postgres rejects",
			events: [delta("a\u0000b"), { type: "assistant_text", at, message_id: "m1", text: "a\u0000b \ud83d" }],
			check: (events) => {
				expect(payloadOf(events, "assistant.message")).toEqual({ message_id: "m1", text: "ab \ufffd" });
				expect(notices[0]).toMatchObject({ type: "delta", text: "ab" });
			},
		},
		{
			name: "truncates long tool output to its byte budget",
			events: [{ type: "tool_result", at, tool_call_id: "c1", tool: "bash", is_error: true, output_preview: `\u0000${"x".repeat(40_000)}` }],
			check: (events) => {
				const preview = payloadOf(events, "tool.result").output_preview ?? "";
				expect(jsonBytes(preview)).toBeLessThanOrEqual(32 * 1024);
				expect(jsonBytes(preview)).toBeGreaterThan(32 * 1024 - 8);
				expect(preview).toMatch(/^x+…\[truncated\]$/);
			},
		},
		{
			// ESC is one character but six bytes in JSON: 60,000 of them are about 360 KB, over the 256 KB payload cap.
			name: "clips by JSON-encoded bytes, so escape-heavy text can't block the events after it",
			events: [
				{ type: "assistant_text", at, message_id: "m1", text: "\u001b".repeat(60_000) },
				{ type: "tool_call", at, tool_call_id: "c1", tool: "bash", args: { command: "\u001b".repeat(40_000) } },
				{ type: "tool_result", at, tool_call_id: "c1", tool: "bash", is_error: false, output_preview: "ok" },
			],
			check: (events) => {
				expect(events.map((e) => e.type)).toEqual(["agent_run.started", "assistant.message", "tool.call", "tool.result", "agent_run.finished"]);
				expect(jsonBytes(payloadOf(events, "assistant.message").text ?? "")).toBeLessThanOrEqual(64 * 1024);
				expect(jsonBytes(payloadOf(events, "tool.call").args ?? "")).toBeLessThanOrEqual(32 * 1024);
			},
		},
		{
			name: "cuts multi-byte text at a character boundary within the budget",
			events: [{ type: "assistant_text", at, message_id: "m1", text: `${"字".repeat(20_000)}${"🙂".repeat(20_000)}` }],
			check: (events) => {
				const text = payloadOf(events, "assistant.message").text ?? "";
				expect(jsonBytes(text)).toBeLessThanOrEqual(64 * 1024);
				expect(text).toMatch(/^字+🙂*…\[truncated\]$/u);
			},
		},
	])("$name", async ({ events, check }) => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const r = recorder();
		feed(r, ...events);
		await r.finish(SUMMARY);
		check(await logged(r));
		expect(warn).not.toHaveBeenCalled();
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

	it("writes everything once the database is back, and records the outcome even when the rest of the stream can't be written", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const once = flaky(1);
		const recovered = recorder(once);
		feed(recovered, { type: "tool_call", at, tool_call_id: "c1", tool: "ls", args: {} });
		await vi.waitFor(() => expect(once.attempts).toBeGreaterThanOrEqual(1), { timeout: 2000 });
		feed(recovered, { type: "tool_call", at, tool_call_id: "c2", tool: "ls", args: {} });
		await recovered.finish(SUMMARY);
		expect((await logged(recovered)).map((e) => e.type)).toEqual(["agent_run.started", "tool.call", "tool.call", "agent_run.finished"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent run events not recorded"));

		const twice = flaky(2);
		const lost = recorder(twice);
		for (let i = 0; i < 1005; i++) feed(lost, { type: "tool_call", at, tool_call_id: `c${i}`, tool: "ls", args: {} });
		await vi.waitFor(() => expect(twice.attempts).toBeGreaterThanOrEqual(1), { timeout: 2000 });
		await lost.finish(SUMMARY);
		expect((await logged(lost)).map((e) => e.type)).toEqual(["agent_run.started", "agent_run.finished"]);
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
});
