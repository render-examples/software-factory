import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAgent, large, runAgent } from "../app/agents/index.js";
import { emit } from "../app/events/index.js";
import { PROTOCOL_VERSION, RunnerInput } from "../app/runner/core/protocol.js";
import { REPO_DIR } from "../app/sandbox/types.js";
import { eventLine, FakeSandbox } from "./helpers/fake-sandbox.js";

vi.mock("../app/events/index.js", () => ({ emit: vi.fn(async () => {}) }));

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
	harness: large,
	tools: ["read", "ls", "bash"],
	output: Report,
	maxTurns: 40,
});

const emitted = () => vi.mocked(emit).mock.calls.map(([e]) => e);

beforeEach(() => {
	vi.mocked(emit).mockClear();
	vi.mocked(emit).mockImplementation(async () => {});
});
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

describe("runAgent in a sandbox", () => {
	beforeEach(() => {
		process.env.ANTHROPIC_API_KEY = HOST_KEY;
	});

	it("runs tool-using agents in the sandbox without exposing the model key to commands or events", async () => {
		const sandbox = new FakeSandbox({ jsonl: `${cannedRun({ verdict: "ok", findings: ["x"] })}\n` });
		const run = await runAgent(reviewer, "Review it.", { traceId: "trace-2", sandbox, timeoutMs: 600_000 });

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

		expect(emitted()).toHaveLength(1);
		expect(emitted()[0]).toMatchObject({
			type: "agent.finished",
			traceId: "trace-2",
			payload: {
				outcome: "ok",
				turns: 2,
				harness: "pi",
				harnessVersion: "0.83.0",
				model: "anthropic/claude-opus-5",
				costUsd: run.costUsd,
				usage: run.usage,
			},
		});
	});
});
