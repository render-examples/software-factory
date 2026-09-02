/**
 * The tools an agent can call, and the contract they implement.
 *
 * Every tool acts on the sandbox the workflow bound to this agent run, which
 * app/claude supplies through ToolContext. A tool can never pick a different
 * sandbox, and analysis agents get only the read-only subset.
 */
export { sandboxExec } from "./exec.js";
export { sandboxListDir, sandboxReadFile, sandboxWriteFile } from "./files.js";
export { sandboxApplyPatch } from "./patch.js";
export { sandboxSearch } from "./search.js";
export { readOnlyTools, writeTools } from "./sets.js";
export { MAX_OUTPUT_CHARS, MAX_READ_CHARS, truncate } from "./truncate.js";
export type {
	InferShape,
	Tool,
	ToolContext,
	ToolResult,
	ZodShape,
} from "./types.js";
