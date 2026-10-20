import type { RepoContext } from "../../config/index.js";
import type { PullRequest } from "../../github/index.js";
import { RunError } from "../../runs/index.js";
import { type OpenedSandbox, type SandboxRef, type Sandbox, shq } from "../../sandbox/index.js";

export type OpenSandbox = (repo: RepoContext, ref: SandboxRef) => Promise<OpenedSandbox>;

const HEAD_MOVED = "the PR changed after it was labeled; reapply the label";

/** Opens one sandbox at the PR head with its base branch fetched, runs `fn`, and closes the sandbox whatever happens. */
export async function withPullSandbox<T>(open: OpenSandbox, repo: RepoContext, pull: PullRequest, fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
	let sandbox: OpenedSandbox;
	try {
		sandbox = await open(repo, {
			kind: "pull",
			number: pull.number,
			headSha: pull.headSha,
			baseBranch: pull.baseRef,
		});
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("head moved")) throw headMoved();
		throw err;
	}
	try {
		return await fn(sandbox);
	} finally {
		await sandbox.close().catch((err: unknown) => {
			console.error(
				JSON.stringify({
					level: "warn",
					msg: "could not close sandbox",
					sandbox: sandbox.id,
					error: String(err),
				}),
			);
		});
	}
}

export function headMoved(): RunError {
	return new RunError(HEAD_MOVED, "head_moved");
}

/**
 * The commit the PR branched from: `git merge-base` of the PR head (checked out) and the base branch, which the
 * sandbox fetched to `refs/remotes/origin/<base>`. The reviewer diffs `<mergeBase>...HEAD`.
 */
export async function mergeBase(sandbox: Sandbox, baseBranch: string): Promise<string> {
	const res = await sandbox.exec(`git merge-base ${shq(`refs/remotes/origin/${baseBranch}`)} HEAD`, { asRunner: true });
	const sha = res.stdout.trim();
	if (res.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
		throw new RunError(`couldn't find where this PR branched from \`${baseBranch}\`, so there's no diff to review.`, "no_merge_base");
	}
	return sha;
}
