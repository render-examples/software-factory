import { randomUUID } from "node:crypto";
import type { ExecResult, Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function githubRemoteUrl(owner: string, repo: string): string {
	const unsafe = [owner, repo].some(
		(part) => !GITHUB_SEGMENT.test(part) || part === "." || part === "..",
	);
	if (unsafe) {
		throw new Error(
			"GitHub owner and repository must contain only safe characters",
		);
	}
	return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Run one authenticated Git command. The token reaches Git through a
 * temporary GIT_ASKPASS script so it never appears in .git/config
 * or the process listing.
 */
export async function execGitWithToken(
	sandbox: Sandbox,
	token: string,
	args: readonly string[],
): Promise<ExecResult> {
	if (args[0] !== "git") {
		throw new Error("execGitWithToken accepts only git commands");
	}

	const askpassPath = `/tmp/render-factory-askpass-${randomUUID()}.sh`;
	// x-access-token is what GitHub expects for App installation tokens, and is
	// accepted as the username for a PAT too.
	await sandbox.upload(
		askpassPath,
		`#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' ${shellEscape(token)} ;;
  *) exit 1 ;;
esac
`,
	);

	try {
		const command = [
			"git",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"credential.helper=",
			...args.slice(1),
		]
			.map(shellEscape)
			.join(" ");

		return await sandbox.run(
			`chmod 700 ${shellEscape(askpassPath)} && ` +
				`GIT_ASKPASS=${shellEscape(askpassPath)} GIT_TERMINAL_PROMPT=0 ${command}`,
		);
	} finally {
		await sandbox.run(`rm -f ${shellEscape(askpassPath)}`).catch(() => {});
	}
}
