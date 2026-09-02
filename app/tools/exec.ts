import { z } from "zod";
import { shellEscape } from "../sandbox/index.js";
import { truncate } from "./truncate.js";
import type { Tool, ToolResult } from "./types.js";

const execSchema = {
	command: z.string().describe("The shell command to execute."),
	cwd: z.string().optional().describe("Working directory. Optional."),
};

export const sandboxExec: Tool<typeof execSchema> = {
	name: "sandbox__exec",
	description:
		"Execute a shell command in the sandbox. Returns combined stdout/stderr and the exit code. " +
		"A non-zero exit code is normal output (e.g. failing tests), not a tool error.",
	inputSchema: execSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const command = input.cwd
			? `cd ${shellEscape(input.cwd)} && ${input.command}`
			: input.command;
		const { output, exitCode } = await ctx.sandbox.run(command, {
			signal: ctx.signal,
		});
		const body = truncate(output) || "(no output)";
		return {
			content: exitCode === 0 ? body : `Exit code: ${exitCode}\n${body}`,
			isError: exitCode !== 0,
		};
	},
};
