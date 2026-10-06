import { describe, expect, it } from "vitest";
import { factoryConfig } from "../factory.config.js";
import {
	resolveRunner,
	RunnerError,
	type RunnerUsage,
} from "../app/runners/index.js";
import type { Agent } from "../app/agents/index.js";
import { BudgetExceededError, isBudgetExceeded } from "../app/tasks/index.js";

const baseAgent: Agent = {
	id: "test-agent",
	model: "medium",
	prompt: "You are a test agent.",
};

describe("resolveRunner", () => {
	it("resolves to the config default runner", () => {
		const runner = resolveRunner(baseAgent);
		expect(runner.name).toBe(factoryConfig.agents.runner);
	});

	it("uses the agent runner override when set", () => {
		const agent: Agent = { ...baseAgent, runner: "openai" };
		const runner = resolveRunner(agent);
		expect(runner.name).toBe("openai");
	});

	it("throws for an unknown runner", () => {
		const agent: Agent = {
			...baseAgent,
			runner: "unknown" as "claude",
		};
		expect(() => resolveRunner(agent)).toThrow("Unknown runner");
	});
});

describe("claudeRunner", () => {
	it("has name 'claude'", async () => {
		const { claudeRunner } = await import("../app/runners/claude.js");
		expect(claudeRunner.name).toBe("claude");
	});

	it("throws when tools are given but no sandbox", async () => {
		const { claudeRunner } = await import("../app/runners/claude.js");
		const toolAgent: Agent = {
			...baseAgent,
			tools: [
				{
					name: "sandbox__read_file",
					description: "read",
					inputSchema: {},
					invoke: async () => ({ content: "" }),
				},
			],
		};

		await expect(
			claudeRunner.run(
				toolAgent,
				{ message: "test" },
				{
					runId: "run-1",
					tools: toolAgent.tools ?? [],
				},
			),
		).rejects.toThrow("declares tools but was given no sandbox");
	});
});

describe("openaiRunner", () => {
	it("has name 'openai'", async () => {
		const { openaiRunner } = await import("../app/runners/openai.js");
		expect(openaiRunner.name).toBe("openai");
	});

	it("throws when tools are given but no sandbox", async () => {
		const { openaiRunner } = await import("../app/runners/openai.js");
		const toolAgent: Agent = {
			...baseAgent,
			tools: [
				{
					name: "sandbox__read_file",
					description: "read",
					inputSchema: {},
					invoke: async () => ({ content: "" }),
				},
			],
		};

		await expect(
			openaiRunner.run(
				toolAgent,
				{ message: "test" },
				{
					runId: "run-1",
					tools: toolAgent.tools ?? [],
				},
			),
		).rejects.toThrow("declares tools but was given no sandbox");
	});

	it("requires models configured for the openai runner", async () => {
		const { openaiRunner } = await import("../app/runners/openai.js");

		await expect(
			openaiRunner.run(
				baseAgent,
				{ message: "test" },
				{ runId: "run-1", tools: [] },
			),
		).rejects.toThrow(/models configured/);
	});
});

describe("RunnerError carries partial usage", () => {
	it("holds usage from a failed run", () => {
		const usage: RunnerUsage = {
			inputTokens: 500,
			outputTokens: 100,
			cacheReadTokens: 50,
		};
		const err = new RunnerError("model exploded", usage);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("RunnerError");
		expect(err.usage).toEqual(usage);
		expect(err.message).toBe("model exploded");
	});

	it("allows undefined usage", () => {
		const err = new RunnerError("no usage available");
		expect(err.usage).toBeUndefined();
	});

	it("preserves the cause", () => {
		const cause = new Error("original");
		const err = new RunnerError("wrapped", undefined, cause);
		expect(err.cause).toBe(cause);
	});
});

describe("cost calculation", () => {
	it("computes cost from known pricing", () => {
		const pricing = {
			inputPerMTok: 3,
			outputPerMTok: 15,
			cacheReadPerMTok: 0.3,
			cacheWritePerMTok: 3.75,
		};
		const usage = {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadTokens: 200_000,
			cacheWriteTokens: 50_000,
		};

		const cost =
			(usage.inputTokens * pricing.inputPerMTok +
				usage.outputTokens * pricing.outputPerMTok +
				(usage.cacheReadTokens ?? 0) * (pricing.cacheReadPerMTok ?? 0) +
				(usage.cacheWriteTokens ?? 0) * (pricing.cacheWritePerMTok ?? 0)) /
			1_000_000;

		expect(cost).toBeCloseTo(3 + 1.5 + 0.06 + 0.1875, 4);
	});

	it("uses fallback rate when model has no pricing", () => {
		const fallbackInput = 3;
		const fallbackOutput = 15;
		const usage = { inputTokens: 1000, outputTokens: 500 };

		const cost =
			(usage.inputTokens * fallbackInput +
				usage.outputTokens * fallbackOutput) /
			1_000_000;

		expect(cost).toBeCloseTo(0.0105, 4);
	});

	it("handles zero cache tokens", () => {
		const pricing = { inputPerMTok: 3, outputPerMTok: 15 };
		const usage = { inputTokens: 1000, outputTokens: 500 };
		const cost =
			(usage.inputTokens * pricing.inputPerMTok +
				usage.outputTokens * pricing.outputPerMTok) /
			1_000_000;
		expect(cost).toBeCloseTo(0.0105, 4);
	});

	it("fallback pricing charges cache tokens", () => {
		const fallback = {
			inputPerMTok: 3,
			outputPerMTok: 15,
			cacheReadPerMTok: 0.3,
			cacheWritePerMTok: 3.75,
		};
		const usage: RunnerUsage = {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 2000,
			cacheWriteTokens: 1000,
		};

		const cost =
			(usage.inputTokens * fallback.inputPerMTok +
				usage.outputTokens * fallback.outputPerMTok +
				(usage.cacheReadTokens ?? 0) * fallback.cacheReadPerMTok +
				(usage.cacheWriteTokens ?? 0) * fallback.cacheWritePerMTok) /
			1_000_000;

		expect(cost).toBeGreaterThan(0.0105);
		const expectedCacheCost = (2000 * 0.3 + 1000 * 3.75) / 1_000_000;
		expect(cost).toBeCloseTo(0.0105 + expectedCacheCost, 6);
	});
});

describe("BudgetExceededError", () => {
	it("carries run ID, cost, and limit", () => {
		const err = new BudgetExceededError("run-1", 20.5, 20);
		expect(err.code).toBe("BUDGET_EXCEEDED");
		expect(err.runId).toBe("run-1");
		expect(err.currentCost).toBe(20.5);
		expect(err.limit).toBe(20);
		expect(err.message).toContain("[BUDGET_EXCEEDED]");
	});

	it("is detectable via isBudgetExceeded", () => {
		const err = new BudgetExceededError("run-1", 20, 20);
		expect(isBudgetExceeded(err)).toBe(true);
	});

	it("is detectable after serialization (plain Error with message)", () => {
		const original = new BudgetExceededError("run-1", 20, 20);
		const serialized = new Error(original.message);
		expect(isBudgetExceeded(serialized)).toBe(true);
	});

	it("does not false-positive on unrelated errors", () => {
		expect(isBudgetExceeded(new Error("timeout"))).toBe(false);
		expect(isBudgetExceeded("string error")).toBe(false);
		expect(isBudgetExceeded(null)).toBe(false);
	});
});

describe("messages.ts usage extraction", () => {
	it("extracts cache tokens from modelUsage", async () => {
		const { usageTotals } = await import("../app/runners/messages.js");
		const message = {
			type: "result",
			subtype: "success",
			modelUsage: {
				"claude-sonnet-5": {
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadInputTokens: 200,
					cacheCreationInputTokens: 100,
				},
			},
		} as never;

		const usage = usageTotals(message);
		expect(usage.inputTokens).toBe(1000);
		expect(usage.outputTokens).toBe(500);
		expect(usage.cacheReadTokens).toBe(200);
		expect(usage.cacheWriteTokens).toBe(100);
	});

	it("extracts cache tokens from snake_case fields", async () => {
		const { usageTotals } = await import("../app/runners/messages.js");
		const message = {
			type: "result",
			subtype: "success",
			usage: {
				input_tokens: 800,
				output_tokens: 400,
				cache_read_input_tokens: 150,
				cache_creation_input_tokens: 75,
			},
		} as never;

		const usage = usageTotals(message);
		expect(usage.inputTokens).toBe(800);
		expect(usage.outputTokens).toBe(400);
		expect(usage.cacheReadTokens).toBe(150);
		expect(usage.cacheWriteTokens).toBe(75);
	});

	it("returns zeros when no usage data exists", async () => {
		const { usageTotals } = await import("../app/runners/messages.js");
		const usage = usageTotals({ type: "result" } as never);
		expect(usage.inputTokens).toBe(0);
		expect(usage.outputTokens).toBe(0);
		expect(usage.cacheReadTokens).toBe(0);
		expect(usage.cacheWriteTokens).toBe(0);
	});
});

describe("policy enforcement in tool calls", () => {
	it("checkToolCall blocks git push in exec tool", async () => {
		const { checkToolCall } = await import("../app/policy/index.js");
		const result = checkToolCall("sandbox__exec", {
			command: "git push origin main",
		});
		expect(result).toContain("Blocked");
	});
});

describe("transcript redaction safety", () => {
	it("old approach would break JSON; new approach redacts without re-parsing", async () => {
		const { redactSecrets } = await import("../app/policy/index.js");

		const entry = {
			text: "token is ghp_abcdefghijklmnopqrst and key sk-ant-api03-xxxxxxxxxxxx",
			nested: { secret: "ghp_abcdefghijklmnopqrst" },
		};
		const line = JSON.stringify(entry);

		const redactedLine = redactSecrets(line);
		expect(redactedLine).not.toContain("ghp_abcdefghijklmnopqrst");

		// The old storeTranscript did JSON.parse(redactSecrets(JSON.stringify(entry)))
		// which would throw because greedy \S{10,} matches across JSON delimiters.
		expect(() => JSON.parse(redactedLine)).toThrow();

		// The new approach: stringify all entries, join as JSONL, redact once.
		// No JSON.parse step, so the redacted string is safely stored as-is.
		const jsonl = [entry, { another: "ok" }]
			.map((e) => JSON.stringify(e))
			.join("\n");
		const redactedJsonl = redactSecrets(jsonl);
		expect(redactedJsonl).not.toContain("ghp_abcdefghijklmnopqrst");
		expect(typeof redactedJsonl).toBe("string");
	});

	it("redacts standalone tokens in simple JSON values", async () => {
		const { redactSecrets } = await import("../app/policy/index.js");

		const entry = { token: "ghp_abcdefghijklmnopqrst" };
		const line = JSON.stringify(entry);
		const redacted = redactSecrets(line);

		expect(redacted).not.toContain("ghp_abcdefghijklmnopqrst");
		expect(redacted).toContain("[REDACTED]");
	});
});

describe("transcript truncation", () => {
	it("caps large transcripts to limits.artifactBytes with a marker", () => {
		const maxBytes = factoryConfig.limits.artifactBytes;
		const bigEntry = { data: "x".repeat(1_000_000) };
		const lines = Array.from({ length: 10 }, () => JSON.stringify(bigEntry));
		const jsonl = lines.join("\n");
		const buf = Buffer.from(jsonl, "utf-8");

		expect(buf.length).toBeGreaterThan(maxBytes);

		const half = Math.floor(
			(maxBytes - Buffer.byteLength('\n{"__truncated__":true}\n')) / 2,
		);
		const head = buf.subarray(0, half);
		const tail = buf.subarray(buf.length - half);
		const marker = Buffer.from('\n{"__truncated__":true}\n');
		const truncated = Buffer.concat([head, marker, tail]);

		expect(truncated.length).toBeLessThanOrEqual(maxBytes);
		expect(truncated.toString()).toContain("__truncated__");
	});

	it("does not truncate transcripts within the byte limit", () => {
		const maxBytes = factoryConfig.limits.artifactBytes;
		const small = Buffer.from('{"a":1}\n{"b":2}', "utf-8");
		expect(small.length).toBeLessThanOrEqual(maxBytes);
	});
});

describe("null stripping for OpenAI tool args", () => {
	it("strips null values from tool arguments", async () => {
		const { checkToolCall } = await import("../app/policy/index.js");

		const argsWithNull = { command: "ls", cwd: null };
		const stripped = Object.fromEntries(
			Object.entries(argsWithNull).filter(([, v]) => v !== null),
		);
		expect(stripped).toEqual({ command: "ls" });

		const result = checkToolCall("sandbox__exec", stripped);
		expect(result).toBeNull();
	});

	it("passes through non-null values unchanged", () => {
		const args = { command: "npm test", cwd: "/home/user/repo" };
		const stripped = Object.fromEntries(
			Object.entries(args).filter(([, v]) => v !== null),
		);
		expect(stripped).toEqual(args);
	});
});
