import { type Sandbox, shellEscape } from "../sandbox/index.js";
import { git, REPO_DIR } from "./run.js";
import type { Checkout } from "./types.js";

const MAX_REVIEW_DIFF_CHARS = 200_000;

/**
 * Commit whatever the implementer changed. Returns null when the tree is clean
 * and HEAD has not moved, which is how the workflow detects "no changes".
 */
export async function commitChanges(
	sandbox: Sandbox,
	checkout: Checkout,
	previousSha: string,
	message: string,
): Promise<string | null> {
	await git(
		sandbox,
		`checkout ${shellEscape(checkout.branch)}`,
		"Branch verification",
	);
	await git(sandbox, "add -A", "Git add");

	const staged = await sandbox.run(
		`git -C ${shellEscape(REPO_DIR)} diff --cached --quiet`,
	);
	// 0 means nothing staged, 1 means changes staged, anything else is a failure.
	if (staged.exitCode === 0) {
		const head = (
			await git(sandbox, "rev-parse HEAD", "Current revision")
		).trim();
		return head === previousSha ? null : head;
	}
	if (staged.exitCode !== 1) {
		throw new Error(`Git diff check failed: ${staged.output.slice(0, 500)}`);
	}

	await git(sandbox, `commit -m ${shellEscape(message)}`, "Commit");
	return (await git(sandbox, "rev-parse HEAD", "Committed revision")).trim();
}

/** The full diff sent to reviewers. Fails closed when too large or binary. */
export async function completeDiff(
	sandbox: Sandbox,
	checkout: Checkout,
	headSha: string,
): Promise<string> {
	const diff = await git(
		sandbox,
		`diff --no-ext-diff ${shellEscape(checkout.baseSha)}...${shellEscape(headSha)}`,
		"Git diff",
	);
	if (diff.length > MAX_REVIEW_DIFF_CHARS) {
		throw new Error("Diff is too large for complete automated review");
	}
	if (/^Binary files .* differ$/m.test(diff)) {
		throw new Error("Binary changes require human review");
	}
	return diff;
}
