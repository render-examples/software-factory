import { repository } from "../config/index.js";
import type { Spec } from "../contracts/index.js";
import type { CommandResult } from "../git/index.js";

/** Build the PR body per §4.3 / §8. */
export function pullRequestBody(opts: {
	issueNumber: number;
	spec: Spec;
	summary: string;
	selfReviewNotes: string[];
	verificationResults: CommandResult[];
	runId: string;
	specId: string | null;
	specVersion: number;
	specCommentId: string | null;
	baseSha: string;
	currentBaseTip?: string;
}): string {
	const {
		issueNumber,
		spec,
		summary,
		selfReviewNotes,
		verificationResults,
		runId,
		specId,
		specVersion,
		specCommentId,
		baseSha,
		currentBaseTip,
	} = opts;

	const repo = repository();
	const sections: string[] = [];

	sections.push(`Closes #${issueNumber}.`);
	sections.push("");
	sections.push(`## Summary\n\n${summary}`);

	// Acceptance criteria checklist
	if (spec.acceptanceCriteria.length > 0) {
		sections.push("");
		sections.push("## Acceptance criteria");
		for (const ac of spec.acceptanceCriteria) {
			sections.push(`- [ ] **${ac.id}**: ${ac.text} _(${ac.verification})_`);
		}
	}

	// Verification table
	if (verificationResults.length > 0) {
		sections.push("");
		sections.push("## Verification");
		sections.push("| Command | Exit | Duration |");
		sections.push("| --- | --- | --- |");
		for (const r of verificationResults) {
			const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
			const icon = r.exitCode === 0 ? "✅" : "❌";
			sections.push(`| \`${r.command}\` | ${icon} ${r.exitCode} | ${dur} |`);
		}
	}

	// Self-review notes
	if (selfReviewNotes.length > 0) {
		sections.push("");
		sections.push("## Self-review notes");
		for (const note of selfReviewNotes) {
			sections.push(`- ${note}`);
		}
	}

	// Spec link
	if (specCommentId) {
		sections.push("");
		sections.push(
			`📋 [Specification](https://github.com/${repo.fullName}/issues/${issueNumber}#issuecomment-${specCommentId})`,
		);
	}

	// Base drift warning
	if (currentBaseTip && currentBaseTip !== baseSha) {
		sections.push("");
		sections.push(
			`> ⚠️ The base branch has moved since this PR was based on \`${baseSha.slice(0, 8)}\`. Conflicts, if any, will appear in this PR.`,
		);
	}

	// Marker for idempotent lookup
	sections.push("");
	sections.push(
		`<!-- render-factory:pr run=${runId} spec=${specId ?? "none"} v=${specVersion} -->`,
	);

	return sections.join("\n");
}
