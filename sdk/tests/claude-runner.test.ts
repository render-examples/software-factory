import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RunContext } from "../runner.js";
import type { Tool } from "../tools.js";

const { queryMock, createSdkMcpServerMock, sdkToolMock } = vi.hoisted(() => ({
	queryMock: vi.fn(),
	createSdkMcpServerMock: vi.fn((config) => config),
	sdkToolMock: vi.fn(
		(
			name: string,
			description: string,
			inputSchema: unknown,
			handler: unknown,
		) => ({
			name,
			description,
			inputSchema,
			handler,
		}),
	),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: queryMock,
	createSdkMcpServer: createSdkMcpServerMock,
	tool: sdkToolMock,
}));

import { ClaudeRunner } from "../runners/claude.js";

const baseContext: Omit<RunContext, "tools"> = {
	agentId: "test-agent",
	prompt: "test prompt",
	systemPrompt: "test system prompt",
};

async function runWith(
	tools: RunContext["tools"],
	overrides: Partial<RunContext> = {},
) {
	const runner = new ClaudeRunner();
	for await (const _event of runner.run({
		...baseContext,
		tools,
		...overrides,
	})) {
		// Consume the runner so the SDK query options are captured.
	}
	return queryMock.mock.calls[0][0].options;
}

async function collectEvents(overrides: Partial<RunContext> = {}) {
	const events = [];
	const runner = new ClaudeRunner();
	for await (const event of runner.run({
		...baseContext,
		tools: [],
		...overrides,
	})) {
		events.push(event);
	}
	return events;
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
	process.env.GITHUB_TOKEN = "must-not-reach-runner";
	queryMock.mockImplementation(async function* () {
		yield {
			type: "result",
			subtype: "success",
			is_error: false,
			result: "done",
		};
	});
});

afterEach(() => {
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.GITHUB_TOKEN;
});

describe("ClaudeRunner tool permissions", () => {
	it("restricts built-ins and uses unattended fail-closed permissions", async () => {
		const options = await runWith([{ name: "Read", builtIn: true }]);

		expect(options.tools).toEqual(["Read"]);
		expect(options.allowedTools).toEqual(["Read"]);
		expect(options.permissionMode).toBe("dontAsk");
		expect(options.tools).not.toContain("Bash");
		expect(options.env.ANTHROPIC_API_KEY).toBe("anthropic-test-key");
		expect(options.env).not.toHaveProperty("GITHUB_TOKEN");
	});

	it("disables built-ins for a custom-tool-only agent", async () => {
		const schema = { text: z.string() };
		const custom: Tool<typeof schema> = {
			name: "Echo",
			description: "Echo text",
			inputSchema: schema,
			async invoke(input) {
				return { content: input.text };
			},
		};

		const options = await runWith([custom]);

		expect(options.tools).toEqual([]);
		expect(options.allowedTools).toEqual(["mcp__factory-tools__Echo"]);
		expect(options.mcpServers).toHaveProperty("factory-tools");
	});

	it("keeps MCP tools out of the built-in availability list", async () => {
		const schema = {};
		const custom: Tool<typeof schema> = {
			name: "Custom",
			description: "Custom tool",
			inputSchema: schema,
			async invoke() {
				return { content: "ok" };
			},
		};

		const options = await runWith([{ name: "Read", builtIn: true }, custom]);

		expect(options.tools).toEqual(["Read"]);
		expect(options.allowedTools).toEqual([
			"Read",
			"mcp__factory-tools__Custom",
		]);
	});

	it("forwards the workflow-owned sandbox binding to custom tools", async () => {
		const invoke = vi.fn().mockResolvedValue({ content: "ok" });
		const custom: Tool<{ value: z.ZodString }> = {
			name: "BoundTool",
			description: "Bound tool",
			inputSchema: { value: z.string() },
			invoke,
		};
		const options = await runWith([custom], {
			sandboxId: "sandbox-owned-by-workflow",
		});
		const bridged = options.mcpServers["factory-tools"].tools[0];

		await bridged.handler({ value: "input" });

		expect(invoke).toHaveBeenCalledWith(
			{ value: "input" },
			expect.objectContaining({
				agentId: "test-agent",
				sandboxId: "sandbox-owned-by-workflow",
			}),
		);
	});

	it("bridges a factory hook rejection into SDK PreToolUse", async () => {
		const interceptToolCall = vi.fn().mockResolvedValue({
			action: "reject",
			reason: "blocked by policy",
		});
		const options = await runWith([{ name: "Bash", builtIn: true }], {
			interceptToolCall,
		});
		const hook = options.hooks.PreToolUse[0].hooks[0];

		const result = await hook(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
				tool_use_id: "tool-1",
			},
			"tool-1",
			{ signal: new AbortController().signal },
		);

		expect(interceptToolCall).toHaveBeenCalledWith({
			type: "tool_call",
			id: "tool-1",
			name: "Bash",
			input: { command: "rm -rf /" },
		});
		expect(result.hookSpecificOutput).toMatchObject({
			permissionDecision: "deny",
			permissionDecisionReason: "blocked by policy",
		});
	});
});

describe("ClaudeRunner event mapping", () => {
	it("preserves every text block and tool result", async () => {
		queryMock.mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "first" },
						{
							type: "tool_use",
							id: "tool-1",
							name: "Example",
							input: { value: 1 },
						},
						{ type: "text", text: "second" },
					],
				},
			};
			yield {
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							content: "tool output",
							is_error: false,
						},
					],
				},
			};
			yield {
				type: "result",
				subtype: "success",
				is_error: false,
				result: "done",
			};
		});

		expect(await collectEvents()).toEqual([
			{ type: "text", text: "first" },
			{
				type: "tool_call",
				id: "tool-1",
				name: "Example",
				input: { value: 1 },
			},
			{ type: "text", text: "second" },
			{
				type: "tool_result",
				id: "tool-1",
				name: "Example",
				content: "tool output",
				isError: false,
			},
			{ type: "result", result: "done" },
		]);
	});

	it("maps terminal SDK failures to error events", async () => {
		queryMock.mockImplementation(async function* () {
			yield {
				type: "result",
				subtype: "error_max_turns",
				is_error: true,
				stop_reason: "max turns",
				errors: ["turn budget exhausted"],
				modelUsage: {
					"claude-test": {
						inputTokens: 12,
						outputTokens: 3,
					},
				},
			};
		});

		const [usage, event] = await collectEvents();
		expect(usage).toEqual({
			type: "usage",
			usage: {
				inputTokens: 12,
				outputTokens: 3,
				model: "claude-test",
			},
		});
		expect(event.type).toBe("error");
		if (event.type === "error") {
			expect(event.error.message).toContain("turn budget exhausted");
		}
	});

	it("maps permission denials to errors", async () => {
		queryMock.mockImplementation(async function* () {
			yield {
				type: "system",
				subtype: "permission_denied",
				tool_name: "Bash",
				tool_use_id: "tool-1",
				message: "blocked by policy",
			};
		});

		const [event] = await collectEvents();
		expect(event.type).toBe("error");
		if (event.type === "error") {
			expect(event.error.message).toContain("blocked by policy");
		}
	});
});
