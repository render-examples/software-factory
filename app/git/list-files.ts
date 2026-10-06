import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";

/**
 * List tracked files in the checkout via `git ls-files`.
 * Returns a Set for O(1) membership checks in path validation.
 */
export async function listTrackedFiles(
	sandbox: Sandbox,
	repoDir: string,
): Promise<ReadonlySet<string>> {
	const result = await sandbox.run(
		`git -c core.hooksPath=/dev/null -C ${shellEscape(repoDir)} ls-files`,
	);
	if (result.exitCode !== 0) {
		return new Set();
	}
	return new Set(
		result.output
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
}
