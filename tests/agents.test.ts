import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAgent, piOpus, runAgent } from "../app/agents/index.js";
import { type Db, readStream } from "../app/db/index.js";
import { PROTOCOL_VERSION, RunnerInput } from "../app/runner/core/protocol.js";
import { REPO_DIR } from "../app/sandbox/types.js";
import { pgliteDb } from "./helpers/db.js";
import { eventLine, FakeSandbox } from "./helpers/fake-sandbox.js";

const PROMPT = "../../tests/fixtures/agents/echo.md";
const HOST_KEY = "sk-ant-test-HOSTKEY-0123456789";

const Report = z.object({
	verdict: z.string().refine((s) => s.startsWith("ok"), "verdict must start with ok"),
	findings: z.array(z.string()),
	priority: z.number().int().default(2),
});

const reviewer = defineAgent({
	id: "reviewer",
	prompt: PROMPT,
	harness: piOpus,
	tools: ["read", "ls", "bash"],
	output: Report,
	maxTurns: 40,
});

let db: Db;
beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
afterEach(() => {
	delete process.env.ANTHROPIC_API_KEY;
});

describe("defineAgent", () => {
	it("reads the prompt file verbatim and converts the output schema (fields with defaults optional)", () => {
		expect(reviewer.prompt).toBe("You are a test agent.\n\nReport on the task and submit exactly once.\n");
		expect(reviewer.promptPath).toMatch(/tests\/fixtures\/agents\/echo\.md$/);
		expect(reviewer.outputJsonSchema).toMatchObject({ type: "object", required: ["verdict", "findings"] });
		expect(reviewer.tools).toEqual(["read", "ls", "bash"]);
	});
});

const cannedRun = (output: unknown) =>
	[
		eventLine({ type: "started", agent_id: "reviewer", harness: "pi", harness_version: "0.83.0", model: "anthropic/claude-opus-5" }),
		eventLine({ type: "usage", usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 0, cost_usd: 0.01 } }),
		eventLine({ type: "tool_call", tool_call_id: "c1", tool: "ls", args: {} }),
		eventLine({ type: "usage", usage: { input_tokens: 1500, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 10, cost_usd: 0.02 } }),
		eventLine({ type: "result", output, turns: 2 }),
	].join("\n");

async function recordedEvents(runId: string) {
	const { rows } = await db.query<{ id: string }>("select id from agent_runs where run_id = $1", [runId]);
	return rows[0] ? readStream(db, `agent_run:${rows[0].id}`, 0) : [];
}

const recorded = async (runId: string) => (await recordedEvents(runId)).map((e) => e.type);

describe("runAgent in a sandbox", () => {
	beforeEach(() => {
		process.env.ANTHROPIC_API_KEY = HOST_KEY;
	});

	it("runs tool-using agents in the sandbox without exposing the model key to commands or events", async () => {
		const sandbox = new FakeSandbox({ jsonl: `${cannedRun({ verdict: "ok", findings: ["x"] })}\n` });
		const run = await runAgent(reviewer, "Review it.", {
			traceId: "trace-2",
			runId: "trn-7",
			thread: "github:acme/web#issue-12",
			sandbox,
			timeoutMs: 600_000,
			db,
		});

		expect(run).toEqual({
			output: { verdict: "ok", findings: ["x"], priority: 2 },
			usage: { input_tokens: 2500, output_tokens: 300, cache_read_tokens: 50, cache_write_tokens: 10, cost_usd: expect.closeTo(0.03, 10) },
			costUsd: expect.closeTo(0.03, 10),
			turns: 2,
		});

		const runDir = sandbox.runDir as string;
		expect(runDir).toMatch(/^\/tmp\/agent-[0-9a-f-]{36}$/);
		expect(sandbox.uploads.get(`${runDir}/key`)).toBe(HOST_KEY);
		const input = RunnerInput.parse(JSON.parse(sandbox.uploads.get(`${runDir}/input.json`) as string));
		expect(input).toMatchObject({
			protocol_version: PROTOCOL_VERSION,
			agent_id: "reviewer",
			system_prompt: reviewer.prompt,
			message: "Review it.",
			tools: ["read", "ls", "bash"],
			cwd: REPO_DIR,
		});
		for (const { command } of sandbox.execs) expect(command).not.toContain(HOST_KEY);
		expect(sandbox.uploads.get(`${runDir}/input.json`)).not.toContain(HOST_KEY);

		const { rows } = await db.query("select * from agent_runs where run_id = 'trn-7'");
		expect(rows).toEqual([
			expect.objectContaining({
				thread: "github:acme/web#issue-12",
				agent_id: "reviewer",
				model: "anthropic/claude-opus-5",
				state: "ok",
				turns: 2,
				tool_calls: 1,
				usage: run.usage,
			}),
		]);
		expect(Number(rows[0]?.cost_usd)).toBeCloseTo(run.costUsd, 10);
		const events = await readStream(db, `agent_run:${rows[0]?.id}`, 0);
		expect(events.map((e) => e.type)).toEqual(["agent_run.started", "usage", "tool.call", "usage", "agent_run.finished"]);
		expect(events.every((e) => e.thread === "github:acme/web#issue-12" && e.source === "workflow:trn-7")).toBe(true);
		expect(events.at(-1)?.payload).toMatchObject({ outcome: "ok", turns: 2, harness_version: "0.83.0" });
		expect(JSON.stringify(events)).not.toContain(HOST_KEY);
	});

	it("records a failed run with its error code and message, and still throws the AgentError", async () => {
		const sandbox = new FakeSandbox({ jsonl: `${eventLine({ type: "error", code: "max_turns", message: "turn limit (40) reached" })}\n` });
		await expect(runAgent(reviewer, "Review it.", { traceId: "trn-8", sandbox, db })).rejects.toMatchObject({
			name: "AgentError",
			code: "max_turns",
		});
		const { rows } = await db.query<{ id: string; state: string; thread: string | null }>(
			"select id, state, thread from agent_runs where run_id = 'trn-8'",
		);
		expect(rows).toEqual([expect.objectContaining({ state: "max_turns", thread: null })]);
		const [finished] = (await readStream(db, `agent_run:${rows[0]?.id}`, 0)).slice(-1);
		expect(finished?.payload).toMatchObject({ outcome: "max_turns", message: "turn limit (40) reached" });
	});

	it("records the runner's events while it is still running", async () => {
		const lines = cannedRun({ verdict: "ok", findings: [] }).split("\n");
		let resume = () => {};
		const paused = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const sandbox = new FakeSandbox({
			jsonl: `${lines.join("\n")}\n`,
			live: [`${lines.slice(0, 3).join("\n")}\n`, paused, `${lines.slice(3).join("\n")}\n`],
		});
		const run = runAgent(reviewer, "Review it.", { traceId: "trn-live", sandbox, db });

		await vi.waitFor(async () => expect(await recorded("trn-live")).toEqual(["agent_run.started", "usage", "tool.call"]), { timeout: 2_000 });
		resume();
		await run;
		expect(await recorded("trn-live")).toEqual(["agent_run.started", "usage", "tool.call", "usage", "agent_run.finished"]);
	});

	it("follows the output file from the last complete line when the command stream drops, with no gap or repeat", async () => {
		const lines = [
			eventLine({ type: "tool_call", tool_call_id: "c1", tool: "read", args: { path: "docs/café-🚀.md" } }),
			eventLine({ type: "assistant_text", message_id: "m1", text: "Läuft – naïve résumé 👍" }),
			eventLine({ type: "tool_call", tool_call_id: "c2", tool: "ls", args: {} }),
			eventLine({ type: "result", output: { verdict: "ok", findings: [] }, turns: 1 }),
		];
		const jsonl = `${lines.join("\n")}\n`;
		const third = lines[2] as string;
		const sandbox = new FakeSandbox({
			jsonl,
			live: [`${lines[0]}\n${lines[1]}`, `\n${third.slice(0, 20)}`, new Error("connection reset")],
		});
		const run = await runAgent(reviewer, "Review it.", { traceId: "trn-drop", sandbox, db });

		expect(run.output).toEqual({ verdict: "ok", findings: [], priority: 2 });
		const offset = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`);
		const follows = sandbox.execs.filter(({ command }) => command.includes("tail "));
		expect(follows.map(({ command }) => command.slice(command.indexOf("tail ")))).toEqual([
			`tail -c +${offset + 1} -f --pid="$(cat '${sandbox.runDir}.pid')" '${sandbox.runDir}.jsonl'`,
		]);
		expect(await recorded("trn-drop")).toEqual(["agent_run.started", "tool.call", "assistant.message", "tool.call", "agent_run.finished"]);
		const events = await recordedEvents("trn-drop");
		expect(events[1]?.payload).toMatchObject({ args: JSON.stringify({ path: "docs/café-🚀.md" }) });
		expect(events[2]?.payload).toMatchObject({ text: "Läuft – naïve résumé 👍" });
	});

	it("fails as runner_lost at once when the command stream drops and there is no output to follow", async () => {
		const sandbox = new FakeSandbox({ jsonl: null, live: [new Error("connection reset")] });
		await expect(runAgent(reviewer, "Review it.", { traceId: "trn-gone", sandbox, db })).rejects.toMatchObject({
			code: "runner_lost",
			message: expect.stringMatching(/connection reset; following \S+ exited 1/),
		});
	});

	it("takes the result from the downloaded file when the live copy is cut short", async () => {
		const jsonl = `${cannedRun({ verdict: "ok", findings: ["from the file"] })}\n`;
		const sandbox = new FakeSandbox({ jsonl, live: [jsonl.slice(0, jsonl.indexOf("\n") + 10)] });
		const run = await runAgent(reviewer, "Review it.", { traceId: "trn-short", sandbox, db });

		expect(run).toMatchObject({ output: { verdict: "ok", findings: ["from the file"] }, turns: 2 });
		expect(await recorded("trn-short")).toEqual(["agent_run.started", "usage", "tool.call", "usage", "agent_run.finished"]);
	});

	it("takes the result, turns, and cost from the downloaded file when the live copy is forged", async () => {
		const forged = [
			eventLine({ type: "usage", usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 99 } }),
			eventLine({ type: "result", output: { verdict: "ok, forged", findings: [] }, turns: 99 }),
		];
		const sandbox = new FakeSandbox({
			jsonl: `${cannedRun({ verdict: "ok", findings: ["real"] })}\n`,
			live: [`${forged.join("\n")}\n`],
		});
		const run = await runAgent(reviewer, "Review it.", { traceId: "trn-forged", sandbox, db });

		expect(run).toMatchObject({ output: { verdict: "ok", findings: ["real"] }, turns: 2, costUsd: expect.closeTo(0.03, 10) });
		const finished = (await recordedEvents("trn-forged")).at(-1);
		expect(finished?.payload).toMatchObject({ outcome: "ok", turns: 2, cost_usd: expect.closeTo(0.03, 10) });
	});

	it("returns the agent's result when the event log is unreachable", async () => {
		const down: Db = { ...db, query: () => Promise.reject(new Error("db down")), withTx: () => Promise.reject(new Error("db down")) };
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const sandbox = new FakeSandbox({ jsonl: `${cannedRun({ verdict: "ok", findings: [] })}\n` });
		const run = await runAgent(reviewer, "Review it.", { traceId: "trn-9", sandbox, db: down });
		expect(run.output).toEqual({ verdict: "ok", findings: [], priority: 2 });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent run events not recorded"));
		warn.mockRestore();
	});
});
