import { codeSpan, fenced } from "../../format/index.js";
import type { Sandbox } from "../../sandbox/index.js";
import type { VerifyRun } from "../run-verify.js";

export async function hasChanges(sandbox: Sandbox): Promise<boolean> {
	const res = await sandbox.exec("git status --porcelain --untracked-files=all", { asRunner: true, timeoutMs: 60_000 });
	if (res.exitCode !== 0) throw new Error(`git status exited ${res.exitCode}: ${res.stderr.trim().slice(-300)}`);
	return res.stdout.trim().length > 0;
}

export const allPassed = (runs: readonly VerifyRun[]): boolean => runs.every((r) => r.passed);

export function failureReport(runs: readonly VerifyRun[]): string {
	const failed = runs.filter((r) => !r.passed);
	const sections = failed.map((r) => `### ${codeSpan(r.command)} (${exitText(r)})\n\n${fenced(r.output || "(no output)", "text")}`);
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

export function failureSummary(runs: readonly VerifyRun[]): string {
	return runs
		.filter((r) => !r.passed)
		.map((r) => `${codeSpan(r.command)} (${exitText(r)})`)
		.join(", ");
}

function exitText(run: VerifyRun): string {
	return run.exitCode === null ? "did not finish" : `exit ${run.exitCode}`;
}
