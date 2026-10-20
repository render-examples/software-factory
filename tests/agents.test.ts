import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAgent, runAgent } from "../app/agents/index.js";
import { testing } from "../app/agents/run.js";
import { emit } from "../app/events/index.js";
import { RunnerInput } from "../app/runner/protocol.js";
import { REPO_DIR } from "../app/sandbox/types.js";
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
const reviewer = defineAgent({
	id: "reviewer",
	prompt: PROMPT,
	model: "large",
	tools: ["read", "ls", "bash"],
	output: Report,
	maxTurns: 40,
	thinking: "high",
});

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
		expect(seen).toMatchObject({ agent_id: "synthesizer", message: "Merge the findings.", tools: [], budget_usd: 5 });
		expect(seen?.cwd).toBeUndefined();

		expect(emitted().map((e) => e.type)).toEqual(["agent.started", "agent.finished"]);
		expect(emitted()[1]).toMatchObject({
			traceId: "trace-1",
			payload: { agentId: "synthesizer", outcome: "ok", turns: 2, costUsd: run.costUsd, usage: run.usage },
		});
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

	it("runs tool-using agents in the sandbox without exposing the model key to commands or events", async () => {
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
		expect(sandbox.uploads.get(`${runDir}/key`)).toBe(HOST_KEY);
		const input = RunnerInput.parse(JSON.parse(sandbox.uploads.get(`${runDir}/input.json`) as string));
		expect(input).toMatchObject({ agent_id: "reviewer", message: "Review it.", tools: ["read", "ls", "bash"], cwd: REPO_DIR });
		for (const { command } of sandbox.execs) expect(command).not.toContain(HOST_KEY);
		expect(sandbox.uploads.get(`${runDir}/input.json`)).not.toContain(HOST_KEY);

		expect(emitted()[0]).toMatchObject({ type: "agent.started", payload: { agentId: "reviewer", where: "sandbox", budgetUsd: 3 } });
		expect(emitted()[1]).toMatchObject({ type: "agent.finished", payload: { outcome: "ok", turns: 2, model: "anthropic/claude-opus-5" } });
	});
});
