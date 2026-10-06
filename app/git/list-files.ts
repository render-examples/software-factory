import type { Sandbox } from "../sandbox/index.js";
import { gitRun } from "./run.js";

/**
 * Tracked files in the checkout, for path validation. Returns an empty set
 * when git fails so a listing problem only loses warnings, never a run.
 */
export async function listTrackedFiles(
	sandbox: Sandbox,
): Promise<ReadonlySet<string>> {
	const result = await gitRun(sandbox, "ls-files");
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
