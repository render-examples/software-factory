import { sandboxExec } from "./exec.js";
import { sandboxListDir, sandboxReadFile, sandboxWriteFile } from "./files.js";
import { sandboxApplyPatch } from "./patch.js";
import { sandboxSearch } from "./search.js";
import type { Tool } from "./types.js";

/** What an analysis agent gets: inspect the checkout, change nothing. */
export const readOnlyTools: readonly Tool[] = [
	sandboxReadFile,
	sandboxListDir,
	sandboxSearch,
];

/** What the implementer gets: everything, including exec and writes. */
export const writeTools: readonly Tool[] = [
	sandboxExec,
	sandboxReadFile,
	sandboxWriteFile,
	sandboxApplyPatch,
	sandboxSearch,
	sandboxListDir,
];
