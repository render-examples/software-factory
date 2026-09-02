import type { Sandbox } from "../sandbox/index.js";
import { execGitWithToken } from "./auth.js";
import { REPO_DIR } from "./run.js";
import type { Checkout } from "./types.js";

/**
 * Push the branch and confirm the remote landed on exactly the commit that was
 * reviewed, so a pull request can never be opened against unreviewed code.
 */
export async function verifyPush(
	sandbox: Sandbox,
	token: string,
	checkout: Checkout,
	expectedSha: string,
): Promise<void> {
	const ref = `refs/heads/${checkout.branch}`;

	const push = await execGitWithToken(sandbox, token, [
		"git",
		"-C",
		REPO_DIR,
		"push",
		checkout.remoteUrl,
		`${ref}:${ref}`,
	]);
	if (push.exitCode !== 0) {
		throw new Error(`Push failed: ${push.output.slice(0, 500)}`);
	}

	const remote = await execGitWithToken(sandbox, token, [
		"git",
		"ls-remote",
		checkout.remoteUrl,
		ref,
	]);
	if (remote.exitCode !== 0) {
		throw new Error(`Push verification failed: ${remote.output.slice(0, 500)}`);
	}
	if (remote.output.trim().split(/\s+/)[0] !== expectedSha) {
		throw new Error("Pushed branch SHA does not match the reviewed commit");
	}
}
