import type { EvalCase } from "./case.js";
import type { EvalRun } from "./suite.js";

/** A plain-text table, one row per case, then the reasons each failing case failed. */
export function summaryTable(run: EvalRun): string {
	const rows = run.results.map((r) => [
		r.pass ? "PASS" : "FAIL",
		r.id,
		r.stage,
		`${r.passedTrials}/${r.trials.length}`,
		r.decision ?? "-",
		`$${r.costUsd.toFixed(2)}`,
		`${(r.durationMs / 1000).toFixed(0)}s`,
	]);
	const lines = table(["result", "case", "stage", "trials", "decision", "cost", "time"], rows);
	for (const r of run.results.filter((r) => !r.pass)) {
		lines.push("", `${r.id}:`, ...r.reasons.map((reason) => `  - ${reason}`));
	}
	lines.push("", `${run.passed} passed, ${run.failed} failed, $${run.costUsd.toFixed(2)} spent. Trace: ${run.traceId}`);
	return lines.join("\n");
}

/** What --validate prints for a valid set of cases. */
export function casePlan(cases: readonly EvalCase[]): string {
	const rows = cases.map((c) => [c.id, c.stage, checks(c).join(", ")]);
	return [...table(["case", "stage", "checks"], rows), "", `${cases.length} case(s) valid.`].join("\n");
}

function checks(evalCase: EvalCase): string[] {
	const out: string[] = [];
	switch (evalCase.stage) {
		case "triage": {
			const { expect } = evalCase;
			if (expect.decision) out.push(`decision=${expect.decision}`);
			if (expect.specMustMention) out.push(`spec mentions ${expect.specMustMention.length}`);
			if (expect.questionsMax !== undefined) out.push(`questions<=${expect.questionsMax}`);
			break;
		}
		case "implementation": {
			const { expect } = evalCase;
			if (expect.commands) out.push(`${expect.commands.length} command(s) pass`);
			if (expect.changedFilesMustInclude) out.push(`changes ${expect.changedFilesMustInclude.length} file(s)`);
			if (expect.changedFilesMustNotInclude) out.push(`avoids ${expect.changedFilesMustNotInclude.length} file(s)`);
			if (expect.diffMustMention) out.push(`diff mentions ${expect.diffMustMention.length}`);
			break;
		}
		case "implementation-review": {
			const { expect } = evalCase;
			out.push(`needsRevision=${expect.needsRevision}`);
			if (expect.findings) out.push(`${expect.findings.length} finding(s)`);
			if (expect.maxIssues !== undefined) out.push(`issues<=${expect.maxIssues}`);
			break;
		}
		case "pr-review": {
			const { expect } = evalCase;
			if (expect.riskTier) out.push(`risk=${expect.riskTier}`);
			if (expect.findings) out.push(`${expect.findings.length} finding(s)`);
			if (expect.maxComments !== undefined) out.push(`comments<=${expect.maxComments}`);
			break;
		}
	}
	const { expect } = evalCase;
	if (expect.mustNotContain) out.push(`must not contain ${expect.mustNotContain.length}`);
	if (expect.forbiddenToolArgs) out.push(`forbidden tool args ${expect.forbiddenToolArgs.length}`);
	if (expect.maxCostUsd !== undefined) out.push(`cost<=$${expect.maxCostUsd}`);
	return out;
}

function table(header: string[], rows: string[][]): string[] {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]) =>
		cells
			.map((cell, i) => cell.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}
