import {
	createSdkMcpServer,
	query,
	tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { checkToolCall } from "../policy/index.js";
import type { Sandbox } from "../sandbox/index.js";
import type { Tool, ToolResult } from "../tools/index.js";
import { failureReason, isRecord, usageTotals } from "./messages.js";

/** Custom tools are exposed to Claude through an in-process MCP server. */
const MCP_SERVER = "factory";

/** Claude runs as a subprocess; give it only the variables it needs. */
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

export interface ClaudeRun {
	result: string;
	inputTokens: number;
	outputTokens: number;
}

export interface RunClaudeOptions {
	agentId: string;
	systemPrompt: string;
	prompt: string;
	model: string;
	maxTurns?: number;
	tools?: readonly Tool[];
	sandbox?: Sandbox;
	signal?: AbortSignal;
}

export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeRun> {
	const tools = opts.tools ?? [];
	if (tools.length > 0 && !opts.sandbox) {
		throw new Error(
			`Agent "${opts.agentId}" declares tools but was given no sandbox`,
		);
	}

	const allowed = tools.map((tool) => `mcp__${MCP_SERVER}__${tool.name}`);
	const options: Options = {
		systemPrompt: opts.systemPrompt,
		model: opts.model,
		maxTurns: opts.maxTurns,
		// Claude's own Bash/Read/Write/Edit stay off. Agents reach the machine
		// only through our tools, which keeps every action inside the sandbox
		// the workflow created.
		tools: [],
		allowedTools: allowed.length > 0 ? allowed : undefined,
		permissionMode: "dontAsk",
		env: Object.fromEntries(
			ENV_ALLOWLIST.map((name) => [name, process.env[name]]),
		),
		hooks: { PreToolUse: [{ hooks: [enforcePolicy] }] },
	};

	const sandbox = opts.sandbox;
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
								await tool.invoke(args, { sandbox, signal: opts.signal }),
							),
					),
				),
			}),
		};
	}

	if (opts.signal) {
		options.abortController = abortControllerFor(opts.signal);
	}

	for await (const message of query({ prompt: opts.prompt, options })) {
		if (message.type !== "result") continue;
		if (message.subtype !== "success" || message.is_error) {
			throw new Error(
				`Agent "${opts.agentId}" failed: ${failureReason(message)}`,
			);
		}
		return { result: message.result, ...usageTotals(message) };
	}

	throw new Error(`Agent "${opts.agentId}" produced no result`);
}

/**
 * Claude reports MCP tools as `mcp__<server>__<tool>`. Policy rules are written
 * against the bare tool name, so strip the prefix before checking.
 */
export function bareToolName(name: string): string {
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
	return {
		content: [{ type: "text" as const, text: result.content }],
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
