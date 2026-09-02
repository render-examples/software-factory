import { z } from "zod";
import { MAX_READ_CHARS, truncate } from "./truncate.js";
import type { Tool, ToolResult } from "./types.js";

const readFileSchema = {
	path: z.string().describe("File path within the sandbox."),
};

export const sandboxReadFile: Tool<typeof readFileSchema> = {
	name: "sandbox__read_file",
	description: "Read a UTF-8 file from the sandbox. Returns its contents.",
	inputSchema: readFileSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const content = await ctx.sandbox.readFile(input.path);
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
		"Create or overwrite a UTF-8 file in the sandbox. Parent directories are created automatically.",
	inputSchema: writeFileSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		await ctx.sandbox.writeFile(input.path, input.content);
		return {
			content: `Wrote ${Buffer.byteLength(input.content, "utf-8")} bytes to ${input.path}`,
		};
	},
};

const listDirSchema = {
	path: z.string().optional().describe("Directory path. Defaults to '.'."),
};

export const sandboxListDir: Tool<typeof listDirSchema> = {
	name: "sandbox__list_dir",
	description:
		"List entries in a directory. Directories are suffixed with '/'. Defaults to the sandbox root.",
	inputSchema: listDirSchema,
	async invoke(input, ctx): Promise<ToolResult> {
		const entries = await ctx.sandbox.listDir(input.path || ".");
		return { content: entries.join("\n") || "(empty directory)" };
	},
};
