import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import { git, gitRun } from "./run.js";
import type { Checkout } from "./types.js";

const MAX_REVIEW_DIFF_CHARS = 200_000;

/** Commit staged changes. Returns null when nothing changed. */
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

	const staged = await gitRun(sandbox, `diff --cached --quiet`);
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

/** Full diff for reviewers. Notes binary content instead of failing. */
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
	return diff;
}
