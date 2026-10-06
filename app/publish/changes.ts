/**
 * Collect and validate the change set from a sandbox diff.
 * Refusals prevent publishing symlinks, submodules, workflow files
 * (unless allowed), oversized diffs, or too many files.
 */
import { target } from "../config/index.js";
import { git } from "../git/index.js";
import { shellEscape } from "../shell/index.js";
import type { Sandbox } from "../sandbox/index.js";

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

export type ChangeStatus = "A" | "M" | "D" | "T";

export interface ChangeEntry {
	status: ChangeStatus;
	path: string;
	mode: string;
}

export interface ChangeSet {
	entries: ChangeEntry[];
	additions: ChangeEntry[];
	deletions: ChangeEntry[];
}

export interface RefusalReason {
	kind:
		| "symlink"
		| "submodule"
		| "workflow_file"
		| "too_many_files"
		| "too_large";
	detail: string;
}

/**
 * Parse `git diff --raw -z --no-renames <baseSha> HEAD` into entries.
 * The -z flag NUL-separates fields for reliable binary-safe parsing.
 * Format per entry: ":<old_mode> <new_mode> <old_sha> <new_sha> <status>\0<path>\0"
 */
export function parseDiffRaw(raw: string): ChangeEntry[] {
	const entries: ChangeEntry[] = [];
	const parts = raw.split("\0").filter(Boolean);

	let i = 0;
	while (i < parts.length) {
		const header = parts[i];
		if (!header.startsWith(":")) {
			i++;
			continue;
		}

		const path = parts[i + 1];
		if (path === undefined) break;

		// Header format: ":100644 100644 abc123 def456 M"
		const tokens = header.slice(1).split(/\s+/);
		const newMode = tokens[1] ?? "100644";
		const status = (tokens[4] ?? "M").charAt(0) as ChangeStatus;

		entries.push({ status, path, mode: newMode });
		i += 2;
	}

	return entries;
}

/**
 * Collect the change set from the sandbox and validate it against
 * the refusal rules. Returns either the valid change set or a list
 * of refusal reasons.
 */
export async function collectChanges(
	sandbox: Sandbox,
	baseSha: string,
): Promise<
	{ ok: true; changes: ChangeSet } | { ok: false; reasons: RefusalReason[] }
> {
	const raw = await git(
		sandbox,
		`diff --raw -z --no-renames ${shellEscape(baseSha)} HEAD`,
		"Collect change set",
	);

	const entries = parseDiffRaw(raw);
	const reasons: RefusalReason[] = [];

	for (const entry of entries) {
		if (entry.mode === "120000") {
			reasons.push({
				kind: "symlink",
				detail: `Symlink: ${entry.path}`,
			});
		}
		if (entry.mode === "160000") {
			reasons.push({
				kind: "submodule",
				detail: `Submodule: ${entry.path}`,
			});
		}
		if (
			entry.path.startsWith(".github/workflows/") &&
			!target().allowWorkflowChanges
		) {
			reasons.push({
				kind: "workflow_file",
				detail: `Workflow file change not allowed: ${entry.path}`,
			});
		}
	}

	if (entries.length > MAX_FILES) {
		reasons.push({
			kind: "too_many_files",
			detail: `${entries.length} files changed, limit is ${MAX_FILES}`,
		});
	}

	if (reasons.length > 0) {
		return { ok: false, reasons };
	}

	const additions = entries.filter((e) => e.status !== "D");
	const deletions = entries.filter((e) => e.status === "D");

	return {
		ok: true,
		changes: { entries, additions, deletions },
	};
}

/**
 * Check total size of changed files. Called after transfer when we
 * know the actual byte sizes.
 */
export function checkTotalSize(
	files: ReadonlyMap<string, Buffer>,
): RefusalReason | null {
	let total = 0;
	for (const buf of files.values()) {
		total += buf.length;
	}
	if (total > MAX_TOTAL_BYTES) {
		return {
			kind: "too_large",
			detail: `Total size ${total} bytes exceeds ${MAX_TOTAL_BYTES} byte limit`,
		};
	}
	return null;
}
