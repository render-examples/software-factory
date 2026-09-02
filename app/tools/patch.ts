import { z } from "zod";
import { shellEscape } from "../shell/index.js";
import { truncate } from "./truncate.js";
import type { Tool, ToolResult } from "./types.js";

const applyPatchSchema = {
	diff: z.string().describe("A unified diff in `git apply` format."),
	cwd: z.string().optional().describe("Working directory for the patch. Optional."),
};

let patchCounter = 0;

export const sandboxApplyPatch: Tool<typeof applyPatchSchema> = {
	name: "sandbox__apply_patch",
	description:
		"Apply a unified diff (git apply format) to files in the sandbox. Prefer this for multi-file edits.",
	inputSchema: applyPatchSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const patchPath = `/tmp/.render-factory-${Date.now()}-${++patchCounter}.patch`;
		await ctx.sandbox.upload(patchPath, input.diff);

		const cd = input.cwd ? `cd ${shellEscape(input.cwd)} && ` : "";
		const { output, exitCode } = await ctx.sandbox.run(
			`${cd}git apply --whitespace=nowarn ${patchPath} && rm ${patchPath}`,
			{ signal: ctx.signal },
		);
		if (exitCode !== 0) {
			return {
				content: `Patch failed (exit ${exitCode}):\n${truncate(output)}`,
				isError: true,
			};
		}
		return { content: "Patch applied successfully." };
	},
};
