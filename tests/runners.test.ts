import { describe, expect, it } from "vitest";
import { factoryConfig } from "../factory.config.js";
import { resolveRunner } from "../app/runners/index.js";
import type { Agent } from "../app/agents/types.js";
import { BudgetExceededError, isBudgetExceeded } from "../app/tasks/errors.js";

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
