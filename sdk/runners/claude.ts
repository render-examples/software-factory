/**
 * ClaudeRunner — AgentRunner backed by the Claude Agent SDK.
 * Built-in tools pass through to the SDK; custom tools are bridged via MCP.
 */
import {
	query,
	createSdkMcpServer,
	tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner, AgentEvent, RunContext } from "../runner.js";
import {
	isBuiltIn,
	isCustomTool,
	type Tool,
	type ToolContext,
	type BuiltInTool,
	type ToolSource,
} from "../tools.js";
import { createClaudeModelResolver, type ModelResolver } from "../models.js";

const CLAUDE_BUILTIN_NAMES = new Set([
	"Read",
	"Edit",
	"Write",
	"Bash",
	"Grep",
	"Glob",
	"NotebookEdit",
]);

export class ClaudeBuiltInToolSource implements ToolSource {
	readonly id = "claude-built-in";

	resolve(): BuiltInTool[] {
		return [...CLAUDE_BUILTIN_NAMES].map((name) => ({
			name,
			builtIn: true as const,
		}));
	}
}

const MCP_SERVER_NAME = "factory-tools";
const CLAUDE_ENV_ALLOWLIST = [
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
	"TEMP",
	"TMP",
	"TMPDIR",
	"USER",
] as const;

function claudeEnvironment(): Record<string, string | undefined> {
	return Object.fromEntries(
		CLAUDE_ENV_ALLOWLIST.map((name) => [name, process.env[name]]),
	);
}

export class ClaudeRunner implements AgentRunner {
	private readonly modelResolver: ModelResolver;

	constructor(opts?: { modelResolver?: ModelResolver }) {
		this.modelResolver = opts?.modelResolver ?? createClaudeModelResolver();
	}

	async *run(ctx: RunContext): AsyncIterable<AgentEvent> {
		const builtInNames: string[] = [];
		const customTools: Tool[] = [];

		for (const tool of ctx.tools) {
			if (isBuiltIn(tool) && CLAUDE_BUILTIN_NAMES.has(tool.name)) {
				builtInNames.push(tool.name);
			} else if (isCustomTool(tool)) {
				customTools.push(tool);
			}
		}

		const abortController = ctx.signal
			? abortControllerFromSignal(ctx.signal)
			: undefined;

		// MCP tools are namespaced as mcp__<server>__<tool> by the SDK
		const mcpToolNames = customTools.map(
			(t) => `mcp__${MCP_SERVER_NAME}__${t.name}`,
		);
		const allAllowed = [...builtInNames, ...mcpToolNames];

		const options: Options = {
			systemPrompt: ctx.systemPrompt,
			// `tools` controls built-in availability; `allowedTools` only controls
			// approval. Keep both explicit so unattended runs fail closed.
			tools: builtInNames,
			allowedTools: allAllowed.length > 0 ? allAllowed : undefined,
			permissionMode: "dontAsk",
			env: claudeEnvironment(),
			maxTurns: ctx.maxTurns,
		};

		if (ctx.model) {
			const resolved = this.modelResolver.resolve(ctx.model);
			options.model = resolved.model;
			if (resolved.baseUrl) {
				options.env = {
					...options.env,
					ANTHROPIC_BASE_URL: resolved.baseUrl,
				};
			}
		}

		if (abortController) {
			options.abortController = abortController;
		}

		const interceptToolCall = ctx.interceptToolCall;
		if (interceptToolCall) {
			options.hooks = {
				PreToolUse: [
					{
						hooks: [
							async (input) => {
								if (input.hook_event_name !== "PreToolUse") return {};
								const toolInput =
									input.tool_input !== null &&
									typeof input.tool_input === "object" &&
									!Array.isArray(input.tool_input)
										? (input.tool_input as Record<string, unknown>)
										: {};
								const intercepted = await interceptToolCall({
									type: "tool_call",
									id: input.tool_use_id,
									name: input.tool_name,
									input: toolInput,
								});

								if (intercepted.action === "reject") {
									return {
										hookSpecificOutput: {
											hookEventName: "PreToolUse" as const,
											permissionDecision: "deny" as const,
											permissionDecisionReason: intercepted.reason,
										},
									};
								}

								const transformed = intercepted.event;
								return {
									hookSpecificOutput: {
										hookEventName: "PreToolUse" as const,
										permissionDecision: "allow" as const,
										...(transformed?.type === "tool_call" && {
											updatedInput: transformed.input,
										}),
									},
								};
							},
						],
					},
				],
			};
		}

		if (customTools.length > 0) {
			const toolDefs = customTools.map((t) =>
				bridgeToolToSdk(t, ctx.agentId, ctx.sandboxId, ctx.signal),
			);
			options.mcpServers = {
				[MCP_SERVER_NAME]: createSdkMcpServer({
					name: MCP_SERVER_NAME,
					tools: toolDefs,
					alwaysLoad: true,
				}),
			};
		}

		try {
			const toolNames = new Map<string, string>();
			for await (const msg of query({ prompt: ctx.prompt, options })) {
				for (const event of mapSdkMessage(msg, toolNames)) {
					yield event;
				}
			}
		} catch (err) {
			yield {
				type: "error",
				error: err instanceof Error ? err : new Error(String(err)),
			};
		}
	}
}

function bridgeToolToSdk(
	tool: Tool,
	agentId: string,
	sandboxId?: string,
	signal?: AbortSignal,
) {
	const toolCtx: ToolContext = { agentId, sandboxId, signal };

	return sdkTool(
		tool.name,
		tool.description,
		tool.inputSchema,
		async (args) => {
			const result = await tool.invoke(args, toolCtx);
			return {
				content: [{ type: "text" as const, text: result.content }],
				isError: result.isError ?? false,
			};
		},
	);
}

function toolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content);
	return content
		.map((block) => {
			if (
				block !== null &&
				typeof block === "object" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				return block.text;
			}
			return JSON.stringify(block);
		})
		.join("\n");
}

function mapSdkMessage(
	msg: SDKMessage,
	toolNames: Map<string, string>,
): AgentEvent[] {
	const events: AgentEvent[] = [];
	switch (msg.type) {
		case "result": {
			if (msg.subtype !== "success" || msg.is_error) {
				const details =
					"errors" in msg && msg.errors.length > 0
						? msg.errors.join("; ")
						: "result" in msg && typeof msg.result === "string"
							? msg.result
							: (msg.stop_reason ?? msg.subtype);
				return [{ type: "error", error: new Error(details) }];
			}
			return [
				{
					type: "result",
					result: msg.result,
				},
			];
		}
		case "assistant": {
			if (msg.error) {
				return [
					{
						type: "error",
						error: new Error(`Claude assistant error: ${msg.error}`),
					},
				];
			}
			if (Array.isArray(msg.message?.content)) {
				for (const block of msg.message.content) {
					if (block.type === "text") {
						events.push({ type: "text", text: block.text });
					} else if (block.type === "tool_use") {
						toolNames.set(block.id, block.name);
						events.push({
							type: "tool_call",
							id: block.id,
							name: block.name,
							input:
								block.input !== null &&
								typeof block.input === "object" &&
								!Array.isArray(block.input)
									? (block.input as Record<string, unknown>)
									: {},
						});
					}
				}
			}
			return events;
		}
		case "user": {
			if (!Array.isArray(msg.message.content)) return events;
			for (const block of msg.message.content) {
				if (block.type !== "tool_result") continue;
				events.push({
					type: "tool_result",
					id: block.tool_use_id,
					name: toolNames.get(block.tool_use_id) ?? "unknown",
					content: toolResultContent(block.content),
					isError: block.is_error ?? false,
				});
			}
			return events;
		}
		case "system": {
			if (msg.subtype !== "permission_denied") return events;
			return [
				{
					type: "error",
					error: new Error(
						`Tool "${msg.tool_name}" was denied: ${msg.message}`,
					),
				},
			];
		}
		default:
			return events;
	}
}

function abortControllerFromSignal(signal: AbortSignal): AbortController {
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
