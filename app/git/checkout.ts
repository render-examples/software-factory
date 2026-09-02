import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import { execGitWithToken, githubRemoteUrl } from "./auth.js";
import { git, REPO_DIR } from "./run.js";
import type { Checkout } from "./types.js";

export function branchName(issueNumber: number, runId: string): string {
	const suffix = runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
	return `factory/issue-${issueNumber}-${suffix}`;
}

/** Clone the repository and create the run's working branch. */
export async function setupCheckout(
	sandbox: Sandbox,
	token: string,
	repo: { owner: string; repo: string },
	branch: string,
): Promise<Checkout> {
	const remoteUrl = githubRemoteUrl(repo.owner, repo.repo);
	const clone = await execGitWithToken(sandbox, token, [
		"git",
		"clone",
		"--depth=50",
		remoteUrl,
		REPO_DIR,
	]);
	if (clone.exitCode !== 0) {
		throw new Error(`Clone failed: ${clone.output.slice(0, 500)}`);
	}

	const remoteHead = (
		await git(
			sandbox,
			"symbolic-ref --short refs/remotes/origin/HEAD",
			"Default branch discovery",
		)
	).trim();
	if (!remoteHead.startsWith("origin/")) {
		throw new Error(`Unexpected default branch ref: ${remoteHead}`);
	}

	const baseSha = (
		await git(sandbox, `rev-parse ${shellEscape(remoteHead)}`, "Base revision")
	).trim();

	await git(
		sandbox,
		`checkout -b ${shellEscape(branch)} ${shellEscape(remoteHead)}`,
		"Create working branch",
	);
	await git(sandbox, 'config user.name "render-factory[bot]"', "Set commit name");
	await git(sandbox, 'config user.email "bot@render-factory.dev"', "Set commit email");

	return {
		remoteUrl,
		base: remoteHead.slice("origin/".length),
		baseSha,
		branch,
	};
}
