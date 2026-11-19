import type { RepoContext } from "../../config/index.js";
import type { PullRequest } from "../../github/index.js";
import { ExpectedFailure } from "../../runs/index.js";
import { type OpenedSandbox, type Sandbox, type SandboxRef, shq, withSandbox } from "../../sandbox/index.js";
import { SHA } from "../../util/index.js";

export type OpenSandbox = (repo: RepoContext, ref: SandboxRef) => Promise<OpenedSandbox>;

const HEAD_MOVED = "the PR changed after it was labeled; reapply the label";

export function withPullSandbox<T>(open: OpenSandbox, repo: RepoContext, pull: PullRequest, fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
	const openPull = () =>
		open(repo, { kind: "pull", number: pull.number, headSha: pull.headSha, baseBranch: pull.baseRef }).catch((err: unknown) => {
			if (err instanceof Error && err.message.startsWith("head moved")) throw headMoved();
			throw err;
		});
	return withSandbox(openPull, fn);
}

export function headMoved(): ExpectedFailure {
	return new ExpectedFailure(HEAD_MOVED, "head_moved");
}

export async function mergeBase(sandbox: Sandbox, baseBranch: string): Promise<string> {
	const res = await sandbox.exec(`git merge-base ${shq(`refs/remotes/origin/${baseBranch}`)} HEAD`, { asRunner: true });
	const sha = res.stdout.trim();
	if (res.exitCode !== 0 || !SHA.test(sha)) {
		throw new ExpectedFailure(`couldn't find where this PR branched from \`${baseBranch}\`, so there's no diff to review.`, "no_merge_base");
	}
	return sha;
}
