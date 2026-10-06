import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import { git } from "./run.js";
import type { Checkout } from "./types.js";

export function branchName(issueNumber: number, runId: string): string {
	const suffix = runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
	return `factory/issue-${issueNumber}-${suffix}`;
}

/** Create a new branch at the given SHA using hardened git. */
export async function createBranch(
	sandbox: Sandbox,
	branch: string,
	startSha: string,
): Promise<void> {
	await git(
		sandbox,
		`checkout -b ${shellEscape(branch)} ${shellEscape(startSha)}`,
		"Create working branch",
	);
}

/**
 * Set up the checkout state after a workspace lease. The lease already
 * has the repo cloned; this creates the working branch.
 */
export async function setupBranch(
	sandbox: Sandbox,
	branch: string,
	baseSha: string,
	baseBranch: string,
): Promise<Checkout> {
	await createBranch(sandbox, branch, baseSha);
	return {
		remoteUrl: "",
		base: baseBranch,
		baseSha,
		branch,
	};
}
