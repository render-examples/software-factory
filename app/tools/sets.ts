import { sandboxExec } from "./exec.js";
import { sandboxListDir, sandboxReadFile, sandboxWriteFile } from "./files.js";
import { sandboxApplyPatch } from "./patch.js";
import { sandboxSearch } from "./search.js";
import type { Tool } from "./types.js";

export const readTools: readonly Tool[] = [
	sandboxReadFile,
	sandboxListDir,
	sandboxSearch,
];

export const writeTools: readonly Tool[] = [
	sandboxWriteFile,
	sandboxApplyPatch,
];

export const execTools: readonly Tool[] = [sandboxExec];
