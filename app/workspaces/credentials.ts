import { randomUUID } from "node:crypto";
import { githubToken } from "../github/index.js";
import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";

/**
 * Hardened git environment: no global/system config, no terminal prompt,
 * no hooks, no fsmonitor, and an empty credential helper so nothing
 * caches tokens.
 */
const HARDENED_GIT_ENV = [
	"GIT_CONFIG_GLOBAL=/dev/null",
	"GIT_CONFIG_SYSTEM=/dev/null",
	"GIT_TERMINAL_PROMPT=0",
].join(" ");

function hardenedGitArgs(): string[] {
	return [
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"credential.helper=",
	];
}

function buildGitCommand(subArgs: readonly string[]): string {
	return ["git", ...hardenedGitArgs(), ...subArgs].map(shellEscape).join(" ");
}

async function writeAskpassScript(
	sandbox: Sandbox,
	token: string,
): Promise<string> {
	const askpassPath = `/tmp/render-factory-askpass-${randomUUID()}.sh`;
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
	return askpassPath;
}

async function removeAskpassScript(
	sandbox: Sandbox,
	path: string,
): Promise<void> {
	await sandbox.run(`rm -f ${shellEscape(path)}`).catch(() => {});
}

function expectedRemoteUrl(owner: string, repo: string): string {
	return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Verify .git/config contains no credential and the remote URL is
 * the plain HTTPS URL with no embedded token.
 */
export async function verifyNoCredentialLeak(
	sandbox: Sandbox,
	dir: string,
	owner: string,
	repo: string,
): Promise<void> {
	const gitConfig = await sandbox.mustRun(
		`cat ${shellEscape(`${dir}/.git/config`)}`,
		"Read .git/config for credential verification",
	);

	if (
		gitConfig.includes("x-access-token") ||
		gitConfig.includes("ghs_") ||
		gitConfig.includes("ghp_")
	) {
		throw new Error("Credential leak detected: .git/config contains a token");
	}

	const expected = expectedRemoteUrl(owner, repo);
	const remoteResult = await sandbox.run(
		`git -C ${shellEscape(dir)} remote get-url origin`,
	);
	const remoteUrl = remoteResult.output.trim();
	if (remoteUrl !== expected) {
		throw new Error(
			`Remote URL mismatch: expected ${expected}, got ${remoteUrl}`,
		);
	}
}

export interface CloneOpts {
	owner: string;
	repo: string;
	branch?: string;
	depth?: number;
}

/**
 * Clone a repository into a sandbox directory using a short-lived
 * read-only token. The token is delivered through GIT_ASKPASS and
 * scrubbed immediately after the clone.
 */
export async function cloneWithReadToken(
	sandbox: Sandbox,
	_repo: CloneOpts,
	dir: string,
): Promise<void> {
	const token = await githubToken({ permissions: { contents: "read" } });
	const askpassPath = await writeAskpassScript(sandbox, token);

	try {
		const remoteUrl = expectedRemoteUrl(_repo.owner, _repo.repo);
		const gitArgs = [
			"clone",
			...(_repo.depth ? [`--depth=${_repo.depth}`] : []),
			...(_repo.branch ? ["--branch", _repo.branch] : []),
			remoteUrl,
			dir,
		];
		const command = buildGitCommand(gitArgs);
		const result = await sandbox.run(
			`chmod 700 ${shellEscape(askpassPath)} && ` +
				`${HARDENED_GIT_ENV} GIT_ASKPASS=${shellEscape(askpassPath)} ${command}`,
		);

		if (result.exitCode !== 0) {
			throw new Error(
				`Clone failed (exit ${result.exitCode}): ${result.output.slice(0, 500)}`,
			);
		}
	} finally {
		await removeAskpassScript(sandbox, askpassPath);
	}

	await verifyNoCredentialLeak(sandbox, dir, _repo.owner, _repo.repo);
}

/**
 * Fetch a refspec into an existing checkout using a short-lived
 * read-only token.
 */
export async function fetchWithReadToken(
	sandbox: Sandbox,
	dir: string,
	refspec: string,
	opts: { owner: string; repo: string },
): Promise<void> {
	const token = await githubToken({ permissions: { contents: "read" } });
	const askpassPath = await writeAskpassScript(sandbox, token);

	try {
		const gitArgs = ["-C", dir, "fetch", "origin", refspec];
		const command = buildGitCommand(gitArgs);
		const result = await sandbox.run(
			`chmod 700 ${shellEscape(askpassPath)} && ` +
				`${HARDENED_GIT_ENV} GIT_ASKPASS=${shellEscape(askpassPath)} ${command}`,
		);

		if (result.exitCode !== 0) {
			throw new Error(
				`Fetch failed (exit ${result.exitCode}): ${result.output.slice(0, 500)}`,
			);
		}
	} finally {
		await removeAskpassScript(sandbox, askpassPath);
	}

	await verifyNoCredentialLeak(sandbox, dir, opts.owner, opts.repo);
}
