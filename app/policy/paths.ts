import { factoryConfig } from "../../factory.config.js";

/** Tools whose arguments are paths, and so must stay inside the checkout. */
export const PATH_TOOLS = new Set([
	"sandbox__read_file",
	"sandbox__write_file",
	"sandbox__list_dir",
]);

/** Returns a reason when any string argument escapes the allowed roots. */
export function pathEscape(input: Record<string, unknown>): string | null {
	for (const value of Object.values(input)) {
		if (typeof value !== "string") continue;
		const normalized = value.replace(/\/+/g, "/");

		if (normalized.includes("/../") || normalized.startsWith("../")) {
			return "path traversal via ../";
		}
		if (
			normalized.startsWith("/") &&
			!normalized.startsWith(factoryConfig.repoDir) &&
			!normalized.startsWith("/tmp/")
		) {
			return `absolute path outside the checkout: ${normalized.slice(0, 60)}`;
		}
	}
	return null;
}
