import type { EvalCase } from "./case.js";
import type { EvalRun } from "./run.js";

/** A plain-text table, one row per case, then the reasons each failing case failed. */
export function summaryTable(run: EvalRun): string {
	const rows = run.results.map((r) => [r.pass ? "PASS" : "FAIL", r.id, r.decision ?? "-", `$${r.costUsd.toFixed(2)}`, `${(r.durationMs / 1000).toFixed(0)}s`]);
	const lines = table(["result", "case", "decision", "cost", "time"], rows);
	for (const r of run.results.filter((r) => !r.pass)) {
		lines.push("", `${r.id}:`, ...r.reasons.map((reason) => `  - ${reason}`));
	}
	lines.push("", `${run.passed} passed, ${run.failed} failed, $${run.costUsd.toFixed(2)} spent. Trace: ${run.traceId}`);
	return lines.join("\n");
}

/** What --validate prints for a valid set of cases. */
export function casePlan(cases: readonly EvalCase[]): string {
	const rows = cases.map((c) => [c.id, c.phase, checks(c.expect).join(", ")]);
	return [...table(["case", "phase", "checks"], rows), "", `${cases.length} case(s) valid.`].join("\n");
}

function checks(expect: EvalCase["expect"]): string[] {
	const out: string[] = [];
	if (expect.decision) out.push(`decision=${expect.decision}`);
	if (expect.specMustMention) out.push(`spec mentions ${expect.specMustMention.length}`);
	if (expect.questionsMax !== undefined) out.push(`questions<=${expect.questionsMax}`);
	if (expect.mustNotContain) out.push(`must not contain ${expect.mustNotContain.length}`);
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
