import {
	createSdkMcpServer,
	query,
	tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { modelFor } from "../config/index.js";
import { checkToolCall } from "../policy/index.js";
import type { ToolResult } from "../tools/index.js";
import { failureReason, isRecord, usageTotals } from "./messages.js";
import type { AgentRunner, RunnerResult } from "./types.js";
import { RunnerError } from "./types.js";

const MCP_SERVER = "factory";

/** Only these env vars are forwarded to the Claude subprocess. */
const ENV_ALLOWLIST = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"HOME",
	"LANG",
	"LC_ALL",
	"NO_PROXY",
	"PATH",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"TMPDIR",
	"USER",
] as const;

export const claudeRunner: AgentRunner = {
	name: "claude",

	async run(agent, input, ctx): Promise<RunnerResult> {
		const tools = ctx.tools;
		if (tools.length > 0 && !ctx.sandbox) {
			throw new Error(
				`Agent "${agent.id}" declares tools but was given no sandbox`,
			);
		}

		const model = modelFor(agent.model, "claude");
		const allowed = tools.map((tool) => `mcp__${MCP_SERVER}__${tool.name}`);
		const options: Options = {
			systemPrompt: agent.prompt,
			model,
			maxTurns: agent.maxTurns,
			tools: [],
			allowedTools: allowed.length > 0 ? allowed : undefined,
			permissionMode: "dontAsk",
			settings: { autoCompactEnabled: true },
			env: Object.fromEntries(
				ENV_ALLOWLIST.map((name) => [name, process.env[name]]),
			),
			hooks: { PreToolUse: [{ hooks: [enforcePolicy] }] },
		};

		const sandbox = ctx.sandbox;
		if (sandbox && tools.length > 0) {
			options.mcpServers = {
				[MCP_SERVER]: createSdkMcpServer({
					name: MCP_SERVER,
					alwaysLoad: true,
					tools: tools.map((tool) =>
						sdkTool(
							tool.name,
							tool.description,
							tool.inputSchema,
							async (args) =>
								toContentBlocks(
									await tool.invoke(args, {
										sandbox,
										signal: ctx.signal,
									}),
								),
						),
					),
				}),
			};
		}

		if (ctx.signal) {
			options.abortController = abortControllerFor(ctx.signal);
		}

		const transcript: unknown[] = [];
		let turns = 0;

		for await (const message of query({ prompt: input.message, options })) {
			transcript.push(message);
			if (message.type === "assistant") turns++;
			if (message.type !== "result") continue;
			if (message.subtype !== "success" || message.is_error) {
				const usage = usageTotals(message);
				const partial =
					usage.inputTokens > 0 || usage.outputTokens > 0
						? {
								inputTokens: usage.inputTokens,
								outputTokens: usage.outputTokens,
								cacheReadTokens: usage.cacheReadTokens || undefined,
								cacheWriteTokens: usage.cacheWriteTokens || undefined,
							}
						: undefined;
				throw new RunnerError(
					`Agent "${agent.id}" failed: ${failureReason(message)}`,
					partial,
				);
			}
			const usage = usageTotals(message);
			return {
				result: message.result,
				usage: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens || undefined,
					cacheWriteTokens: usage.cacheWriteTokens || undefined,
				},
				turns,
				transcript,
			};
		}

		throw new Error(`Agent "${agent.id}" produced no result`);
	},
};

/** Strip the MCP prefix so policy rules match the bare tool name. */
function bareToolName(name: string): string {
	const prefix = `mcp__${MCP_SERVER}__`;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

const enforcePolicy = async (input: {
	hook_event_name: string;
	tool_name?: string;
	tool_input?: unknown;
}) => {
	if (input.hook_event_name !== "PreToolUse") return {};
	const reason = checkToolCall(
		bareToolName(input.tool_name ?? ""),
		isRecord(input.tool_input) ? input.tool_input : {},
	);
	return {
		hookSpecificOutput: reason
			? {
					hookEventName: "PreToolUse" as const,
					permissionDecision: "deny" as const,
					permissionDecisionReason: reason,
				}
			: {
					hookEventName: "PreToolUse" as const,
					permissionDecision: "allow" as const,
				},
	};
};

function toContentBlocks(result: ToolResult) {
	const content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	> = [{ type: "text" as const, text: result.content }];

	if (result.images) {
		for (const img of result.images) {
			content.push({
				type: "image" as const,
				data: img.png.toString("base64"),
				mimeType: "image/png",
			});
		}
	}

	return {
		content,
		isError: result.isError ?? false,
	};
}

function abortControllerFor(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) {
		controller.abort(signal.reason);
	} else {
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	}
	return controller;
}
