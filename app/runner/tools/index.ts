import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type AgentTool,
	type BashToolDetails,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExecutionToolContext,
	type ReadToolDetails,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolName } from "../core/protocol.js";
import { rejectReason } from "./shell-policy.js";

export { rejectReason } from "./shell-policy.js";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1800;
const LS_DEFAULT_LIMIT = 500;
const LS_MAX_LIMIT = 2000;
const OUTPUT_LIMIT = `${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB`;

export interface ToolOptions {
	tools: readonly ToolName[];
	cwd: string;
	scratchDir: string;
}

/** Without edit or write the agent is read-only, and bash applies the read-only shell policy. */
const isReadOnly = (tools: readonly ToolName[]): boolean => !tools.includes("edit") && !tools.includes("write");

/**
 * Builds the child env from an allowlist so nothing from the runner's environment (model credentials,
 * the Render API key) can reach a model-controlled process.
 */
function shellEnv(path: string | undefined, scratchDir: string): Record<string, string> {
	return {
		PATH: path || "/usr/local/bin:/usr/bin:/bin",
		LANG: process.env.LANG || "C.UTF-8",
		HOME: scratchDir,
		TMPDIR: scratchDir,
		PAGER: "cat",
		GIT_PAGER: "cat",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		// The checkout can be owned by another uid; without this git refuses "dubious ownership".
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "safe.directory",
		GIT_CONFIG_VALUE_0: "*",
	};
}

/** The tools named in `opts.tools`, in that order, all rooted at `opts.cwd`. */
// biome-ignore lint/suspicious/noExplicitAny: tools with different parameter schemas share one list, as in Pi.
export function createTools(opts: ToolOptions): AgentTool<any>[] {
	const context: ExecutionToolContext = {
		env: new NodeExecutionEnv({ cwd: opts.cwd, shellEnv: shellEnv(process.env.PATH, opts.scratchDir) }),
	};
	// biome-ignore lint/suspicious/noExplicitAny: see above.
	const factories: Record<ToolName, () => AgentTool<any>> = {
		read: () => createTextReadTool(context, opts),
		ls: () => createLsTool(opts),
		bash: () => createShellTool(context, opts, isReadOnly(opts.tools)),
		edit: () => withContext(createEditTool(), context),
		write: () => withContext(createWriteTool(), context),
	};
	return [...new Set(opts.tools)].map((name) => factories[name]());
}

/** A factory tool as any harness registers it: JSON Schema parameters and a text result, no library types. */
export interface FactoryTool {
	name: ToolName;
	description: string;
	/** JSON Schema of the arguments. */
	parameters: Record<string, unknown>;
	/** Validates `args`, runs the tool, and never throws: a failure comes back with `isError`. */
	execute(args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
}

let nextCallId = 0;

/**
 * The tools named in `opts.tools` as FactoryTools: the same implementations, environment, policy, and limits as
 * `createTools`, so every harness gives an agent identical tool behavior.
 */
export function createFactoryTools(opts: ToolOptions): FactoryTool[] {
	return createTools(opts).map((tool) => ({
		name: tool.name as ToolName,
		description: tool.description,
		parameters: tool.parameters as Record<string, unknown>,
		async execute(args, signal) {
			if (!Value.Check(tool.parameters as TSchema, args)) {
				const problems = [...Value.Errors(tool.parameters as TSchema, args)].map((e) => `${e.instancePath || "(root)"}: ${e.message}`);
				return { text: `Invalid arguments for ${tool.name}:\n${problems.map((p) => `- ${p}`).join("\n")}`, isError: true };
			}
			try {
				const result = await tool.execute(`factory-${++nextCallId}`, args, signal);
				return { text: contentText(result.content), isError: false };
			} catch (err) {
				return { text: err instanceof Error ? err.message : String(err), isError: true };
			}
		},
	}));
}

/** A tool result's text content; other content types become a placeholder. */
export function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : `[${c?.type ?? "unknown"}]`)).join("\n");
}

type ContextTool = ReturnType<typeof createEditTool> | ReturnType<typeof createWriteTool>;

/** Binds one of Pi's harness tools (which take the execution context per call) to `context`. */
// biome-ignore lint/suspicious/noExplicitAny: see createTools.
function withContext(inner: ContextTool, context: ExecutionToolContext): AgentTool<any> {
	return {
		...inner,
		// biome-ignore lint/suspicious/noExplicitAny: the params match inner.parameters, validated by Pi.
		execute: (toolCallId: string, params: any, signal?: AbortSignal) => inner.execute(toolCallId, params, signal, undefined, context),
	};
}

/** Pi's read tool without image attachments: images only cost tokens. */
function createTextReadTool(context: ExecutionToolContext, { cwd }: ToolOptions) {
	const inner = createReadTool();
	const tool: AgentTool<typeof inner.parameters, ReadToolDetails | undefined> = {
		...inner,
		description:
			`Read a text file. path is relative to ${cwd} or absolute. offset is the first line to read (1-based) and ` +
			`limit the number of lines. Output is truncated to ${OUTPUT_LIMIT}; continue with offset for the rest.`,
		async execute(toolCallId, params, signal) {
			const result = await inner.execute(toolCallId, params, signal, undefined, context);
			const content = result.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[image omitted]" } : c));
			return { ...result, content };
		},
	};
	return tool;
}

const LsParams = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Directory to list, relative to the working directory or absolute (default: the working directory)" }),
	),
	limit: Type.Optional(Type.Integer({ description: `Maximum entries to return (default ${LS_DEFAULT_LIMIT})` })),
});

function createLsTool({ cwd }: ToolOptions): AgentTool<typeof LsParams> {
	return {
		name: "ls",
		label: "ls",
		description: `List a directory's entries in sorted order, with a trailing / on directories. Paths are relative to ${cwd}.`,
		parameters: LsParams,
		async execute(_toolCallId, { path, limit }) {
			const entries = await readdir(resolve(cwd, path ?? "."), { withFileTypes: true });
			const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort((a, b) => a.localeCompare(b));
			const max = Math.min(Math.max(limit ?? LS_DEFAULT_LIMIT, 1), LS_MAX_LIMIT);
			let text = names.slice(0, max).join("\n") || "(empty directory)";
			if (names.length > max) text += `\n\n[${names.length - max} more entries; raise limit or use bash]`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

/** Pi's bash tool with an allowlisted env and bounded timeouts; read-only agents also get the shell policy. */
function createShellTool(context: ExecutionToolContext, { cwd, scratchDir }: ToolOptions, readOnly: boolean) {
	const inner = createBashTool({
		prepare: (execution) => {
			execution.cwd = cwd;
			execution.env = shellEnv(process.env.PATH, scratchDir);
			execution.inheritEnv = false;
		},
	});
	const limits = `Output keeps the last ${OUTPUT_LIMIT}. timeout is in seconds: default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.`;
	const description = readOnly
		? `Run a bash command for read-only inspection. Working directory: ${cwd}. Writable scratch directory: ${scratchDir} ` +
			"($HOME and $TMPDIR point there). Use it to search (rg, git grep, find), for git history (git log/show/blame/diff), " +
			"sed -n, wc, and scripts or tests that do not modify the working directory. Commands that write outside scratch, " +
			`mutating git commands, network tools, package installs, and sudo are rejected. ${limits}`
		: `Run a bash command. Working directory: ${cwd}. Scratch directory: ${scratchDir} ($HOME and $TMPDIR point there). ${limits}`;
	const tool: AgentTool<typeof inner.parameters, BashToolDetails | undefined> = {
		...inner,
		description,
		async execute(toolCallId, params, signal, onUpdate) {
			const reason = readOnly ? rejectReason(params.command, scratchDir) : undefined;
			if (reason) {
				throw new Error(
					`Command rejected by the read-only shell policy: ${reason}. ` +
						"This agent can't modify the working directory; inspect with read-only commands instead.",
				);
			}
			const timeout = Math.min(Math.max(params.timeout ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
			return inner.execute(toolCallId, { ...params, timeout }, signal, onUpdate, context);
		},
	};
	return tool;
}
