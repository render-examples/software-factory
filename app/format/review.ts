import type { Finding, Review, ReviewerOutput } from "../contracts/index.js";

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * Render one reviewer's findings for the judge. Falls back to the raw text
 * when the reviewer did not return parseable JSON, so nothing is silently lost.
 */
export function reviewerSection(
	title: string,
	parsed: ReviewerOutput | null,
	raw: string,
): string {
	if (!parsed || parsed.findings.length === 0) return `## ${title}\n${raw}`;

	const findings = [...parsed.findings].sort(
		(a: Finding, b: Finding) =>
			SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
			b.confidence - a.confidence,
	);
	const lines = findings.map(
		(f) =>
			`- **${f.severity.toUpperCase()}** (confidence: ${f.confidence}) \`${f.file}\`: ${f.description}`,
	);
	return `## ${title}\n${lines.join("\n")}`;
}

export function reviewSummary(review: Review): string {
	const verdict =
		review.decision === "approve" ? "approved" : "changes requested";
	const header =
		`## Internal review: ${verdict}\n\n` +
		`**Risk tier:** ${review.riskTier ?? "unknown"}\n\n${review.summary}`;

	const findings = review.topFindings;
	if (!findings || findings.length === 0) return header;

	const rows = findings.map(
		(f) =>
			`| ${f.severity} | ${f.confidence} | ${f.source} | \`${f.file}\` | ${f.description} |`,
	);
	return (
		`${header}\n\n### Top findings\n\n` +
		"| Severity | Confidence | Source | File | Description |\n| --- | --- | --- | --- | --- |\n" +
		rows.join("\n")
	);
}

export function pullRequestBody(
	issueNumber: number,
	review: Review,
	implementationSummary: string,
): string {
	return (
		`Automated implementation for #${issueNumber}.\n\n` +
		`${reviewSummary(review)}\n\n` +
		`## Implementation report\n\n${implementationSummary}\n\nCloses #${issueNumber}.`
	);
}
