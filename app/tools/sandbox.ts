/**
 * Agent-visible Render Sandbox tools.
 *
 * These are application capabilities, not SDK primitives. The SDK defines the
 * Tool and Sandbox contracts and resolves the workflow-owned sandbox binding
 * once per agent run; these tools read the already-connected sandbox off the
 * execution environment.
 */
import { z } from "zod";
import {
	collectExecOutput,
	shellEscape,
	type Sandbox,
	type Tool,
	type ToolContext,
	type ToolResult,
} from "#factory/sdk";

const MAX_OUTPUT_CHARS = 50_000;
const MAX_READ_CHARS = 100_000;

function truncate(value: string, limit = MAX_OUTPUT_CHARS): string {
	if (value.length <= limit) return value;
	return (
		value.slice(0, limit) +
		`\n... (truncated, ${value.length - limit} chars omitted)`
	);
}

let patchCounter = 0;

function uniquePatchPath(): string {
	return `/tmp/.render-agent-${Date.now()}-${++patchCounter}.patch`;
}

/** Orchestration binds the sandbox; the model can never select one. */
function requireSandbox(ctx: ToolContext): Sandbox {
	const sandbox = ctx.environment?.sandbox;
	if (!sandbox) {
		throw new Error(`Agent "${ctx.agentId}" has no sandbox binding`);
	}
	return sandbox;
}

const execSchema = {
	command: z.string().describe("The shell command to execute."),
	cwd: z.string().optional().describe("Working directory. Optional."),
};

export const sandboxExec: Tool<typeof execSchema> = {
	name: "sandbox__exec",
	description:
		"Execute a shell command in a sandbox. Returns combined stdout/stderr and the exit code. " +
		"A non-zero exit code is normal output (e.g. failing tests), not a tool error.",
	inputSchema: execSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const sandbox = requireSandbox(ctx);
		const command = input.cwd
			? `cd ${shellEscape(input.cwd)} && ${input.command}`
			: input.command;
		const events = await sandbox.exec(command, { signal: ctx.signal });
		const { output, exitCode } = await collectExecOutput(events);
		const body = truncate(output) || "(no output)";
		return {
			content: exitCode === 0 ? body : `Exit code: ${exitCode}\n${body}`,
			isError: exitCode !== 0,
		};
	},
};

const readFileSchema = {
	path: z.string().describe("File path within the sandbox."),
};

export const sandboxReadFile: Tool<typeof readFileSchema> = {
	name: "sandbox__read_file",
	description: "Read a UTF-8 file from a sandbox. Returns its contents.",
	inputSchema: readFileSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const sandbox = requireSandbox(ctx);
		const content = await sandbox.readFile(input.path);
		return { content: truncate(content, MAX_READ_CHARS) };
	},
};

const writeFileSchema = {
	path: z.string().describe("File path within the sandbox."),
	content: z.string().describe("Full file contents to write."),
};

export const sandboxWriteFile: Tool<typeof writeFileSchema> = {
	name: "sandbox__write_file",
	description:
		"Create or overwrite a UTF-8 file in a sandbox. Parent directories are created automatically.",
	inputSchema: writeFileSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const sandbox = requireSandbox(ctx);
		await sandbox.writeFile(input.path, input.content);
		return {
			content: `Wrote ${Buffer.byteLength(input.content, "utf-8")} bytes to ${input.path}`,
		};
	},
};

const listDirSchema = {
	path: z
		.string()
		.optional()
		.describe("Directory path. Defaults to '.'."),
};

export const sandboxListDir: Tool<typeof listDirSchema> = {
	name: "sandbox__list_dir",
	description:
		"List entries in a directory. Directories are suffixed with '/'. Defaults to the sandbox root.",
	inputSchema: listDirSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const sandbox = requireSandbox(ctx);
		const entries = await sandbox.listDir(input.path || ".");
		return { content: entries.join("\n") || "(empty directory)" };
	},
};

const applyPatchSchema = {
	diff: z.string().describe("A unified diff in `git apply` format."),
	cwd: z
		.string()
		.optional()
		.describe("Working directory for the patch. Optional."),
};

export const sandboxApplyPatch: Tool<typeof applyPatchSchema> = {
	name: "sandbox__apply_patch",
	description:
		"Apply a unified diff (git apply format) to files in a sandbox. Prefer this for multi-file edits.",
	inputSchema: applyPatchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const sandbox = requireSandbox(ctx);
		const patchPath = uniquePatchPath();
		await sandbox.upload(patchPath, input.diff);
		const cdPrefix = input.cwd ? `cd ${shellEscape(input.cwd)} && ` : "";
		const events = await sandbox.exec(
			`${cdPrefix}git apply --whitespace=nowarn ${patchPath} && rm ${patchPath}`,
			{ signal: ctx.signal },
		);
		const { output, exitCode } = await collectExecOutput(events);
		if (exitCode !== 0) {
			return {
				content: `Patch failed (exit ${exitCode}):\n${truncate(output)}`,
				isError: true,
			};
		}
		return { content: "Patch applied successfully." };
	},
};

const searchSchema = {
	pattern: z.string().describe("Regex pattern to search for."),
	path: z
		.string()
		.optional()
		.describe("Directory or file to search. Defaults to '.'."),
	include: z
		.string()
		.optional()
		.describe("Glob to filter files (e.g. '*.ts'). Optional."),
};

export const sandboxSearch: Tool<typeof searchSchema> = {
	name: "sandbox__search",
	description:
		"Search file contents using ripgrep (rg). Returns matching lines with file paths and line numbers.",
	inputSchema: searchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const sandbox = requireSandbox(ctx);
		const args = ["rg", "--line-number", "--no-heading"];
		if (input.include) args.push("--glob", input.include);
		args.push("--", input.pattern, input.path || ".");
		const events = await sandbox.exec(args.map(shellEscape).join(" "), {
			signal: ctx.signal,
		});
		const { output, exitCode } = await collectExecOutput(events);
		if (exitCode === 1) return { content: "(no matches)" };
		if (exitCode > 1) {
			return {
				content: `Search failed (exit ${exitCode}):\n${truncate(output)}`,
				isError: true,
			};
		}
		return { content: truncate(output) };
	},
};

export const allSandboxTools: readonly Tool[] = [
	sandboxExec,
	sandboxReadFile,
	sandboxWriteFile,
	sandboxListDir,
	sandboxApplyPatch,
	sandboxSearch,
];
