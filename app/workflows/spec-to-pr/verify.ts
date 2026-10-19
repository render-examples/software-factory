import { codeSpan, type VerifyResult } from "../../format/index.js";
import type { Sandbox } from "../../sandbox/index.js";

export const VERIFY_TIMEOUT_MS = 20 * 60 * 1000;
/** How much of a command's output the repair run sees. */
const OUTPUT_TAIL_CHARS = 4096;

/** A verify command as the workflow ran it. */
export interface VerifyRun extends VerifyResult {
	/** null when the command didn't finish (timeout or a lost exec). */
	exitCode: number | null;
	/** The last OUTPUT_TAIL_CHARS of stdout and stderr. Repository output: send it to the model, never to GitHub. */
	output: string;
}

/** Runs each verify command as the runner user, in order, and records every result. Never throws for a failing command. */
export async function runVerify(sandbox: Sandbox, commands: readonly string[], now: () => number = Date.now): Promise<VerifyRun[]> {
	const runs: VerifyRun[] = [];
	for (const command of commands) {
		const started = now();
		try {
			const res = await sandbox.exec(command, { asRunner: true, timeoutMs: VERIFY_TIMEOUT_MS });
			const output = [res.stdout.trimEnd(), res.stderr.trimEnd()].filter(Boolean).join("\n");
			runs.push({ command, passed: res.exitCode === 0, exitCode: res.exitCode, output: tail(output), durationMs: now() - started });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			runs.push({ command, passed: false, exitCode: null, output: tail(`The command did not finish: ${message}`), durationMs: now() - started });
		}
	}
	return runs;
}

/** Whether the working tree differs from the checkout, untracked files included. */
export async function hasChanges(sandbox: Sandbox): Promise<boolean> {
	const res = await sandbox.exec("git status --porcelain --untracked-files=all", { asRunner: true, timeoutMs: 60_000 });
	if (res.exitCode !== 0) throw new Error(`git status exited ${res.exitCode}: ${res.stderr.trim().slice(-300)}`);
	return res.stdout.trim().length > 0;
}

export const allPassed = (runs: readonly VerifyRun[]): boolean => runs.every((r) => r.passed);

/** The failing output, for a repair run's message. */
export function failureReport(runs: readonly VerifyRun[]): string {
	const failed = runs.filter((r) => !r.passed);
	const sections = failed.map((r) => `### ${codeSpan(r.command)} (${exitText(r)})\n\n${fenced(r.output || "(no output)")}`);
	return [
		"## Failing verify output",
		"",
		"The workflow reran the verify commands after your last attempt, and these failed. This is a repair run: fix them.",
		"",
		...sections.flatMap((s) => [s, ""]),
	]
		.join("\n")
		.trimEnd();
}

/** One line for the status comment: which commands failed. No output, which is repository content. */
export function failureSummary(runs: readonly VerifyRun[]): string {
	return runs
		.filter((r) => !r.passed)
		.map((r) => `${codeSpan(r.command)} (${exitText(r)})`)
		.join(", ");
}

function exitText(run: VerifyRun): string {
	return run.exitCode === null ? "did not finish" : `exit ${run.exitCode}`;
}

function tail(text: string): string {
	return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}

/** A fenced block that the text can't close early. */
function fenced(text: string): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}text\n${text}\n${fence}`;
}
