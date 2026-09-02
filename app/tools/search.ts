import { z } from "zod";
import { shellEscape } from "../sandbox/index.js";
import { truncate } from "./truncate.js";
import type { Tool, ToolResult } from "./types.js";

const searchSchema = {
	pattern: z.string().describe("Regex pattern to search for."),
	path: z.string().optional().describe("Directory or file to search. Defaults to '.'."),
	include: z.string().optional().describe("Glob to filter files (e.g. '*.ts'). Optional."),
};

export const sandboxSearch: Tool<typeof searchSchema> = {
	name: "sandbox__search",
	description:
		"Search file contents using ripgrep. Returns matching lines with file paths and line numbers.",
	inputSchema: searchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const args = ["rg", "--line-number", "--no-heading"];
		if (input.include) args.push("--glob", input.include);
		args.push("--", input.pattern, input.path || ".");

		const { output, exitCode } = await ctx.sandbox.run(
			args.map(shellEscape).join(" "),
			{ signal: ctx.signal },
		);
		// ripgrep exits 1 when there are simply no matches.
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
