import { collectExecOutput, shellEscape, type Sandbox } from "#factory/sdk";
import { execGitWithToken } from "../../lib/sandbox-git.js";
import { MAX_REVIEW_DIFF_CHARS, REPO_DIR } from "./constants.js";
import type { CommitCheckpoint, ReadySandboxCheckpoint } from "./contracts.js";

export async function runCommand(
	sandbox: Sandbox,
	command: string,
	label: string,
): Promise<string> {
	const events = await sandbox.exec(command);
	const { output, exitCode } = await collectExecOutput(events);
	if (exitCode !== 0) {
		throw new Error(
			`${label} failed (exit ${exitCode}): ${output.slice(0, 500)}`,
		);
	}
	return output;
}

interface EnsureCommitOptions {
	sandbox: Sandbox;
	state: ReadySandboxCheckpoint;
	previousSha: string;
	message: string;
}

export async function ensureCommit({
	sandbox,
	state,
	previousSha,
	message,
}: EnsureCommitOptions): Promise<CommitCheckpoint | null> {
	await runCommand(
		sandbox,
		`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} checkout ${shellEscape(state.branch)}`,
		"Branch verification",
	);
	await runCommand(
		sandbox,
		`git -C ${shellEscape(REPO_DIR)} add -A`,
		"Git add",
	);
	const diffCheck = await sandbox.exec(
		`git -C ${shellEscape(REPO_DIR)} diff --cached --quiet`,
	);
	const { exitCode, output } = await collectExecOutput(diffCheck);
	if (exitCode === 0) {
		const head = (
			await runCommand(
				sandbox,
				`git -C ${shellEscape(REPO_DIR)} rev-parse HEAD`,
				"Current revision",
			)
		).trim();
		return head === previousSha ? null : { sha: head };
	}
	if (exitCode !== 1) {
		throw new Error(`Git diff check failed: ${output.slice(0, 500)}`);
	}

	await runCommand(
		sandbox,
		`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} commit -m ${shellEscape(message)}`,
		"Commit",
	);
	const sha = (
		await runCommand(
			sandbox,
			`git -C ${shellEscape(REPO_DIR)} rev-parse HEAD`,
			"Committed revision",
		)
	).trim();
	return { sha };
}

interface CompleteDiffOptions {
	sandbox: Sandbox;
	state: ReadySandboxCheckpoint;
	headSha: string;
}

export async function completeDiff({
	sandbox,
	state,
	headSha,
}: CompleteDiffOptions): Promise<string> {
	const diff = await runCommand(
		sandbox,
		`git -C ${shellEscape(REPO_DIR)} diff --no-ext-diff ${shellEscape(state.baseSha)}...${shellEscape(headSha)}`,
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

interface VerifyPushOptions {
	sandbox: Sandbox;
	token: string;
	state: ReadySandboxCheckpoint;
	expectedSha: string;
}

export async function verifyPush({
	sandbox,
	token,
	state,
	expectedSha,
}: VerifyPushOptions): Promise<CommitCheckpoint> {
	const push = await execGitWithToken(sandbox, token, [
		"git",
		"-C",
		REPO_DIR,
		"push",
		state.remoteUrl,
		`refs/heads/${state.branch}:refs/heads/${state.branch}`,
	]);
	if (push.exitCode !== 0) {
		throw new Error(`Push failed: ${push.output.slice(0, 500)}`);
	}
	const remote = await execGitWithToken(sandbox, token, [
		"git",
		"ls-remote",
		state.remoteUrl,
		`refs/heads/${state.branch}`,
	]);
	if (remote.exitCode !== 0) {
		throw new Error(`Push verification failed: ${remote.output.slice(0, 500)}`);
	}
	const pushedSha = remote.output.trim().split(/\s+/)[0];
	if (pushedSha !== expectedSha) {
		throw new Error("Pushed branch SHA does not match the reviewed commit");
	}
	return { sha: pushedSha };
}
