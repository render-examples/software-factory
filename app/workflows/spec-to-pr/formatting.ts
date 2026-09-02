import type { ReviewDecision } from "./contracts.js";

export function formatReviewBody(review: ReviewDecision): string {
	const tier = review.riskTier ?? "unknown";
	const header = `## Internal review: ${review.decision === "approve" ? "approved" : "changes requested"}\n\n**Risk tier:** ${tier}\n\n${review.summary}`;
	const findings = review.topFindings;
	if (!findings || findings.length === 0) return header;
	const rows = findings.map(
		(f) =>
			`| ${f.severity} | ${f.confidence} | ${f.source} | \`${f.file}\` | ${f.description} |`,
	);
	return `${header}\n\n### Top findings\n\n| Severity | Confidence | Source | File | Description |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}`;
}

export function clarificationComment(
	questions: string[],
	triggerLabel: string,
): string {
	const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
	return `The factory needs more detail before it can proceed:\n\n${numbered}\n\nReply with the details, then reapply the \`${triggerLabel}\` label.`;
}

export function noChangesComment(triggerLabel: string): string {
	return `The factory produced no repository changes. Reapply the \`${triggerLabel}\` label to retry.`;
}

export function verifyFailedComment(
	failures: string,
	maxRounds: number,
	triggerLabel: string,
): string {
	return `The factory could not pass verification after ${maxRounds} fix rounds:\n\n\`\`\`\n${failures.slice(0, 3000)}\n\`\`\`\n\nReapply the \`${triggerLabel}\` label to retry.`;
}

export function changesRequestedComment(
	summary: string,
	triggerLabel: string,
): string {
	return `The factory stopped after its revision still needed changes:\n\n${summary}\n\nReapply the \`${triggerLabel}\` label after updating the issue or repository.`;
}

export function draftPrComment(pullUrl: string): string {
	return `The factory opened a reviewed draft pull request: ${pullUrl}`;
}

export function prBody(
	issueNumber: number,
	review: ReviewDecision,
	implementationRaw: string,
): string {
	return (
		`Automated implementation for #${issueNumber}.\n\n` +
		`${formatReviewBody(review)}\n\n` +
		`## Implementation report\n\n${implementationRaw}\n\nCloses #${issueNumber}.`
	);
}
