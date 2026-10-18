import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentError, defineAgent, renderPrompt, runAgent } from "../app/agents/index.js";
import { testing } from "../app/agents/run.js";
import { modelFor } from "../app/config/index.js";
import { emit } from "../app/events/index.js";
import { RunnerInput } from "../app/runner/protocol.js";
import { APP_DIR, REPO_DIR, SCRATCH_DIR } from "../app/sandbox/types.js";
import { eventLine, FakeSandbox } from "./helpers/fake-sandbox.js";
import { call, SUBMIT, say } from "./helpers/runner.js";

vi.mock("../app/events/index.js", () => ({ emit: vi.fn(async () => {}) }));

const PROMPT = "../../tests/fixtures/agents/echo.md";
const HOST_KEY = "sk-ant-test-HOSTKEY-0123456789";

const Report = z.object({
	verdict: z.string().refine((s) => s.startsWith("ok"), "verdict must start with ok"),
	findings: z.array(z.string()),
	priority: z.number().int().default(2),
});

const synthesizer = defineAgent({ id: "synthesizer", prompt: PROMPT, model: "small", tools: [], output: Report, maxTurns: 5 });
const reviewer = defineAgent({ id: "reviewer", prompt: PROMPT, model: "large", tools: ["read", "ls", "bash"], output: Report, maxTurns: 40, thinking: "high" });

const vars = { repo: "acme/web", issue: "12" };
const emitted = () => vi.mocked(emit).mock.calls.map(([e]) => e);

beforeEach(() => {
	vi.mocked(emit).mockClear();
	vi.mocked(emit).mockImplementation(async () => {});
});
afterEach(() => {
	testing.fauxScript = undefined;
	delete process.env.ANTHROPIC_API_KEY;
});

describe("defineAgent", () => {
	it("reads the prompt file verbatim and converts the output schema (fields with defaults optional)", () => {
		expect(synthesizer.prompt).toBe("You are a test agent for {{repo}}.\n\nReport on issue #{{ issue }} and submit exactly once.\n");
		expect(synthesizer.promptPath).toMatch(/tests\/fixtures\/agents\/echo\.md$/);
		expect(synthesizer.outputJsonSchema).toMatchObject({ type: "object", required: ["verdict", "findings"] });
		expect(reviewer.tools).toEqual(["read", "ls", "bash"]);
	});

	it("fails fast on a missing prompt file or a bad maxTurns", () => {
		expect(() => defineAgent({ id: "x", prompt: "missing.md", model: "small", tools: [], output: Report, maxTurns: 1 })).toThrow(/ENOENT/);
		expect(() => defineAgent({ id: "x", prompt: PROMPT, model: "small", tools: [], output: Report, maxTurns: 0 })).toThrow(/maxTurns/);
	});
});

describe("renderPrompt", () => {
	it("fills {{name}} placeholders in one pass", () => {
		expect(renderPrompt(synthesizer.prompt, vars)).toBe("You are a test agent for acme/web.\n\nReport on issue #12 and submit exactly once.\n");
		expect(renderPrompt("{{a}} {{b}}", { a: "{{b}}", b: "x" })).toBe("{{b}} x");
	});

	it("throws on a placeholder without a value", () => {
		expect(() => renderPrompt(synthesizer.prompt, { repo: "acme/web" })).toThrow("{{issue}}");
	});
});

describe("runAgent in a task (no tools)", { timeout: 30_000 }, () => {
	it("runs the session in-process and returns the Zod-parsed output with usage", async () => {
		let seen: RunnerInput | undefined;
		testing.fauxScript = (input) => {
			seen = input;
			return [say("Thinking it over."), call(SUBMIT, { verdict: "ok: fine", findings: ["a"] })];
		};
		const run = await runAgent(synthesizer, { message: "Merge the findings.", vars }, { traceId: "trace-1", budgetUsd: 5 });

		expect(run.output).toEqual({ verdict: "ok: fine", findings: ["a"], priority: 2 });
		expect(run.turns).toBe(2);
		expect(run.usage.input_tokens).toBeGreaterThan(0);
		expect(run.costUsd).toBeGreaterThan(0);
		expect(run.costUsd).toBe(run.usage.cost_usd);
		expect(seen).toMatchObject({
			trace_id: "trace-1",
			agent_id: "synthesizer",
			system_prompt: renderPrompt(synthesizer.prompt, vars),
			message: "Merge the findings.",
			tools: [],
			budget_usd: 5,
			max_turns: 5,
			thinking_level: "medium",
			...modelOf("small"),
		});
		expect(seen?.cwd).toBeUndefined();

		expect(emitted().map((e) => e.type)).toEqual(["agent.started", "agent.finished"]);
		expect(emitted()[1]).toMatchObject({
			traceId: "trace-1",
			payload: { agentId: "synthesizer", outcome: "ok", turns: 2, costUsd: run.costUsd, usage: run.usage },
		});
	});

	it("rejects output the Zod schema refuses with output_invalid, carrying the usage", async () => {
		testing.fauxScript = () => [call(SUBMIT, { verdict: "nope", findings: [] })];
		const err = await runAgent(synthesizer, { message: "m", vars }, { traceId: "t" }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AgentError);
		expect(err).toMatchObject({ code: "output_invalid", message: expect.stringContaining("verdict must start with ok") });
		expect((err as AgentError).usage.input_tokens).toBeGreaterThan(0);
		expect(emitted()[1]).toMatchObject({ payload: { outcome: "output_invalid" } });
	});

	it("maps a runner error to an AgentError with its code", async () => {
		testing.fauxScript = () => [say("prose"), say("more prose")];
		await expect(runAgent(synthesizer, { message: "m", vars }, { traceId: "t" })).rejects.toMatchObject({ code: "no_submission", turns: 2 });
	});

	it("throws invalid_input for an unknown placeholder, before any model call", async () => {
		let called = false;
		testing.fauxScript = () => {
			called = true;
			return [];
		};
		await expect(runAgent(synthesizer, { message: "m", vars: { repo: "x" } }, { traceId: "t" })).rejects.toMatchObject({ code: "invalid_input" });
		expect(called).toBe(false);
	});

	it("needs the provider key in the environment outside tests", async () => {
		await expect(runAgent(synthesizer, { message: "m", vars }, { traceId: "t" })).rejects.toMatchObject({
			code: "agent_error",
			message: expect.stringContaining("no API key"),
		});
	});

	it("refuses to start without budget", async () => {
		testing.fauxScript = () => [call(SUBMIT, { verdict: "ok", findings: [] })];
		await expect(runAgent(synthesizer, { message: "m", vars }, { traceId: "t", budgetUsd: 0 })).rejects.toMatchObject({ code: "budget_exceeded" });
	});

	it("is unaffected by event failures", async () => {
		vi.mocked(emit).mockImplementation(() => {
			throw new Error("database down");
		});
		testing.fauxScript = () => [call(SUBMIT, { verdict: "ok", findings: [] })];
		await expect(runAgent(synthesizer, { message: "m", vars }, { traceId: "t" })).resolves.toMatchObject({ output: { verdict: "ok" } });
		vi.mocked(emit).mockImplementation(async () => {
			throw new Error("database down");
		});
		await expect(runAgent(synthesizer, { message: "m", vars }, { traceId: "t" })).resolves.toMatchObject({ output: { verdict: "ok" } });
	});
});

const cannedRun = (output: unknown) =>
	[
		eventLine({ type: "started", agent_id: "reviewer", model: "anthropic/claude-opus-5", pi_version: "0.83.0" }),
		eventLine({ type: "usage", usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 50, cache_write_tokens: 0, cost_usd: 0.01 } }),
		eventLine({ type: "tool_call", tool_call_id: "c1", tool: "ls", args: {} }),
		eventLine({ type: "usage", usage: { input_tokens: 1500, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 10, cost_usd: 0.02 } }),
		eventLine({ type: "result", output, turns: 2 }),
	].join("\n");

describe("runAgent in a sandbox", () => {
	beforeEach(() => {
		process.env.ANTHROPIC_API_KEY = HOST_KEY;
	});

	it("uploads the input and the key as files, runs run-agent.sh, and parses the downloaded events", async () => {
		const sandbox = new FakeSandbox({ jsonl: `${cannedRun({ verdict: "ok", findings: ["x"] })}\n` });
		const run = await runAgent(reviewer, { message: "Review it.", vars }, { traceId: "trace-2", sandbox, timeoutMs: 600_000, budgetUsd: 3 });

		expect(run).toEqual({
			output: { verdict: "ok", findings: ["x"], priority: 2 },
			usage: { input_tokens: 2500, output_tokens: 300, cache_read_tokens: 50, cache_write_tokens: 10, cost_usd: expect.closeTo(0.03, 10) },
			costUsd: expect.closeTo(0.03, 10),
			turns: 2,
		});

		const runDir = sandbox.runDir as string;
		expect(runDir).toMatch(/^\/tmp\/agent-[0-9a-f-]{36}$/);
		expect(sandbox.execs.map((e) => e.command)).toEqual([
			`mkdir -m 700 ${runDir}`,
			`bash ${APP_DIR}/run-agent.sh ${runDir} 600`,
			`rm -rf ${runDir} ${runDir}.jsonl ${runDir}.exit`,
		]);
		expect(sandbox.execs[1]?.opts).toMatchObject({ timeoutMs: 660_000 });
		expect(sandbox.execs.every((e) => !e.opts?.asRunner)).toBe(true);
		expect(sandbox.downloads).toEqual([`${runDir}.jsonl`]);

		expect([...sandbox.uploads.keys()]).toEqual([`${runDir}/input.json`, `${runDir}/key`]);
		expect(sandbox.uploads.get(`${runDir}/key`)).toBe(HOST_KEY);
		const input = RunnerInput.parse(JSON.parse(sandbox.uploads.get(`${runDir}/input.json`) as string));
		expect(input).toEqual({
			trace_id: "trace-2",
			agent_id: "reviewer",
			system_prompt: renderPrompt(reviewer.prompt, vars),
			message: "Review it.",
			...modelOf("large"),
			thinking_level: "high",
			tools: ["read", "ls", "bash"],
			output_schema: reviewer.outputJsonSchema,
			max_turns: 40,
			timeout_ms: 600_000,
			budget_usd: 3,
			cwd: REPO_DIR,
			scratch_dir: SCRATCH_DIR,
		});
		for (const { command } of sandbox.execs) expect(command).not.toContain(HOST_KEY);
		expect(sandbox.uploads.get(`${runDir}/input.json`)).not.toContain(HOST_KEY);

		expect(emitted()[0]).toMatchObject({ type: "agent.started", payload: { agentId: "reviewer", where: "sandbox", budgetUsd: 3 } });
		expect(emitted()[1]).toMatchObject({ type: "agent.finished", payload: { outcome: "ok", turns: 2, model: "anthropic/claude-opus-5" } });
	});

	it("revalidates the result with the Zod schema: output_invalid with the run's usage", async () => {
		const sandbox = new FakeSandbox({ jsonl: cannedRun({ verdict: "bad", findings: [] }) });
		const err = await runAgent(reviewer, { message: "m", vars }, { traceId: "t", sandbox }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AgentError);
		expect(err).toMatchObject({ code: "output_invalid", costUsd: expect.closeTo(0.03, 10), turns: 2 });
	});

	it("passes a runner error through with its code", async () => {
		const jsonl = [
			eventLine({ type: "started", agent_id: "reviewer", model: "m", pi_version: "0.83.0" }),
			eventLine({ type: "usage", usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.5 } }),
			eventLine({ type: "error", code: "budget_exceeded", message: "spent" }),
		].join("\n");
		const err = await runAgent(reviewer, { message: "m", vars }, { traceId: "t", sandbox: new FakeSandbox({ jsonl, runExitCode: 1 }) }).catch((e: unknown) => e);
		expect(err).toMatchObject({ code: "budget_exceeded", message: "spent", costUsd: 0.5, turns: 1 });
	});

	it("reports runner_lost without a terminal event, counting invalid lines", async () => {
		const jsonl = [eventLine({ type: "started", agent_id: "reviewer", model: "m", pi_version: "0.83.0" }), "Killed", "{not json"].join("\n");
		const err = await runAgent(reviewer, { message: "m", vars }, { traceId: "t", sandbox: new FakeSandbox({ jsonl, runExitCode: 137 }) }).catch(
			(e: unknown) => e,
		);
		expect(err).toMatchObject({ code: "runner_lost", message: expect.stringContaining("run-agent.sh exited 137") });
		expect(emitted()[1]).toMatchObject({ payload: { outcome: "runner_lost", invalidLines: 2 } });

		const missing = new FakeSandbox({ jsonl: null });
		await expect(runAgent(reviewer, { message: "m", vars }, { traceId: "t", sandbox: missing })).rejects.toMatchObject({
			code: "runner_lost",
			message: expect.stringContaining("cannot download"),
		});
		expect(missing.execs.at(-1)?.command).toMatch(/^rm -rf /);
	});
});

function modelOf(tier: "small" | "medium" | "large") {
	const { provider, model } = modelFor(tier);
	return { model_provider: provider, model };
}

describe("runAgent types", () => {
	it("requires a sandbox exactly when the agent has tools (checked by tsc --noEmit)", () => {
		// Never called: the assertions are the @ts-expect-error directives, which fail tsc if they go unused.
		const rules = (sandbox: FakeSandbox) => {
			// @ts-expect-error an agent with tools needs a sandbox
			void runAgent(reviewer, { message: "m" }, { traceId: "t" });
			// @ts-expect-error an agent without tools runs in the task and takes no sandbox
			void runAgent(synthesizer, { message: "m" }, { traceId: "t", sandbox });
			void runAgent(reviewer, { message: "m" }, { traceId: "t", sandbox });
			const typed: Promise<{ output: { verdict: string; findings: string[]; priority: number } }> = runAgent(
				synthesizer,
				{ message: "m" },
				{ traceId: "t" },
			);
			return typed;
		};
		expect(typeof rules).toBe("function");
	});
});
