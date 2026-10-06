import { target } from "../config/index.js";

export const PATH_TOOLS = new Set([
	"sandbox__read_file",
	"sandbox__write_file",
	"sandbox__list_dir",
	"sandbox__apply_patch",
	"sandbox__search",
]);

/** Returns a reason if any string argument escapes the allowed roots. */
export function pathEscape(input: Record<string, unknown>): string | null {
	const repoDir = target().repoDir;
	for (const value of Object.values(input)) {
		if (typeof value !== "string") continue;
		const normalized = value.replace(/\/+/g, "/");

		if (normalized.includes("/../") || normalized.startsWith("../")) {
			return "path traversal via ../";
		}
		if (
			normalized.startsWith("/") &&
			!normalized.startsWith(repoDir) &&
			!normalized.startsWith("/tmp/")
		) {
			return `absolute path outside the checkout: ${normalized.slice(0, 60)}`;
		}
	}
	return null;
}

/** Check paths embedded in unified-diff headers (`--- a/…` / `+++ b/…`). */
export function patchPathEscape(diff: string): string | null {
	const repoDir = target().repoDir;
	for (const line of diff.split("\n")) {
		const match = line.match(/^(?:---|\+\+\+)\s+(.+)/);
		if (!match) continue;
		let path = match[1].trim();
		path = path.replace(/^[ab]\//, "");
		if (path === "/dev/null") continue;

		if (path.includes("/../") || path.startsWith("../")) {
			return `path traversal in patch header: ${path.slice(0, 60)}`;
		}
		if (
			path.startsWith("/") &&
			!path.startsWith(repoDir) &&
			!path.startsWith("/tmp/")
		) {
			return `absolute path in patch header outside the checkout: ${path.slice(0, 60)}`;
		}
	}
	return null;
}
