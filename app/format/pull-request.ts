import type { Implementation, Spec } from "../schemas/index.js";
import { acceptanceChecklist } from "./spec.js";
import { BODY_MAX_CHARS, bullets, codeSpan, fitAround, sanitize, sanitizeInline } from "./text.js";

const TITLE_MAX_CHARS = 256;

export interface VerifyResult {
	command: string;
	passed: boolean;
	durationMs?: number;
}

export function pullRequestTitle(spec: Spec): string {
	const title = sanitizeInline(spec.title);
	return title.length <= TITLE_MAX_CHARS ? title : `${title.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

export interface PullRequestBodyInput {
	issue: number;
	spec: Spec;
	implementation: Implementation;
	verification?: readonly VerifyResult[];
	specUrl?: string;
}

export function pullRequestBody(input: PullRequestBodyInput): string {
	const { spec, implementation } = input;
	const sections: string[] = [`## Summary\n\n${sanitize(implementation.summary)}`, `## Acceptance criteria\n\n${acceptanceChecklist(spec)}`];

	if (input.verification) {
		sections.push(`## Verification\n\n${verificationTable(input.verification)}`);
	} else if (implementation.verification.length > 0) {
		const rows = implementation.verification.map(
			(v) => `| ${v.passed ? "✅ passed" : "❌ failed"} | ${escapeCell(codeSpan(v.command))} | ${escapeCell(sanitizeInline(v.notes))} |`,
		);
		sections.push(`## Verification (reported by the implementer)\n\n| Result | Command | Notes |\n| --- | --- | --- |\n${rows.join("\n")}`);
	}

	if (implementation.followUps.length > 0) sections.push(`## Follow-ups\n\n${bullets(implementation.followUps)}`);

	const links = input.specUrl ? `\n\n[Specification](${input.specUrl})` : "";
	return fitAround(
		`Closes #${input.issue}.\n\n`,
		sections.join("\n\n"),
		`${links}\n\n---\n\n_Opened as a draft by the factory. Review it before marking it ready._`,
		BODY_MAX_CHARS,
	);
}

export function verificationTable(results: readonly VerifyResult[]): string {
	if (results.length === 0) return "No verify commands are configured.";
	const rows = results.map((r) => {
		const duration = r.durationMs === undefined ? "" : `${(r.durationMs / 1000).toFixed(1)}s`;
		return `| ${r.passed ? "✅ passed" : "❌ failed"} | ${escapeCell(codeSpan(r.command))} | ${duration} |`;
	});
	return ["| Result | Command | Duration |", "| --- | --- | --- |", ...rows].join("\n");
}

function escapeCell(text: string): string {
	return text.replaceAll("|", "\\|");
}
