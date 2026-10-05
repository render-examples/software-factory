import { PATH_TOOLS, patchPathEscape, pathEscape } from "./paths.js";
import { RULES } from "./rules.js";

/** Returns a rejection reason, or null to allow. */
export function checkToolCall(
	name: string,
	input: Record<string, unknown>,
): string | null {
	if (PATH_TOOLS.has(name)) {
		const violation = pathEscape(input);
		if (violation) return `Blocked path escape in ${name}: ${violation}`;
	}

	if (name === "sandbox__apply_patch" && typeof input.diff === "string") {
		const violation = patchPathEscape(input.diff);
		if (violation) return `Blocked path escape in ${name}: ${violation}`;
	}

	const serialized = JSON.stringify(input);
	for (const rule of RULES) {
		if (rule.pattern.test(serialized)) {
			return `Blocked destructive operation: ${rule.label}`;
		}
	}
	return null;
}
