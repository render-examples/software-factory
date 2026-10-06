import { factoryConfig } from "../../factory.config.js";
import type { Spec, SpecValidation } from "../contracts/index.js";

/** Render the spec sections as markdown (no header, no instructions). */
export function renderSpecMarkdown(spec: Spec): string {
	const lines: string[] = [];

	lines.push(`**${spec.title}**`);
	lines.push("");
	lines.push(spec.summary);
	lines.push("");

	lines.push("### Problem");
	lines.push(spec.problem);
	lines.push("");

	lines.push("### Goals");
	for (const goal of spec.goals) {
		lines.push(`- ${goal}`);
	}
	lines.push("");

	if (spec.nonGoals.length > 0) {
		lines.push("### Non-goals");
		for (const ng of spec.nonGoals) {
			lines.push(`- ${ng}`);
		}
		lines.push("");
	}

	lines.push("### Acceptance criteria");
	for (const ac of spec.acceptanceCriteria) {
		lines.push(`- [ ] **${ac.id}**: ${ac.text} _(${ac.verification})_`);
	}
	lines.push("");

	lines.push("### Approach");
	lines.push(spec.approach);
	lines.push("");

	if (spec.affectedAreas.length > 0) {
		lines.push("### Affected areas");
		for (const area of spec.affectedAreas) {
			lines.push(`- \`${area.path}\` — ${area.change}`);
		}
		lines.push("");
	}

	lines.push("### Test plan");
	lines.push(spec.testPlan);
	lines.push("");

	if (spec.risks.length > 0) {
		lines.push("### Risks");
		for (const risk of spec.risks) {
			lines.push(`- ${risk}`);
		}
		lines.push("");
	}

	if (spec.assumptions.length > 0) {
		lines.push("### Assumptions");
		for (const assumption of spec.assumptions) {
			lines.push(`- ${assumption}`);
		}
		lines.push("");
	}

	if (spec.openQuestions.length > 0) {
		lines.push("### Open questions");
		for (const q of spec.openQuestions) {
			lines.push(`- ${q}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Render a spec as a GitHub comment body. Wraps renderSpecMarkdown with
 * version header, path warnings, change summary, and next-step instructions.
 */
export function renderSpecComment(opts: {
	spec: Spec;
	version: number;
	validation: SpecValidation;
	changeSummary?: string;
	approvalRemoved?: boolean;
}): string {
	const { spec, version, validation, changeSummary, approvalRemoved } = opts;
	const lines: string[] = [];

	lines.push(`## 📋 Specification v${version}`);
	lines.push("");
	lines.push(renderSpecMarkdown(spec));

	if (validation.warnings.length > 0) {
		lines.push("### ⚠️ Path warnings");
		for (const w of validation.warnings) {
			lines.push(`- ${w}`);
		}
		lines.push("");
	}

	if (version > 1 && changeSummary) {
		lines.push(`### Changes in v${version}`);
		lines.push(changeSummary);
		lines.push("");
	}

	if (approvalRemoved) {
		lines.push(
			`> **Note:** The \`${factoryConfig.labels.specApproved}\` label was removed because a new version was drafted. Please re-apply it to approve this version.`,
		);
		lines.push("");
	}

	lines.push("---");
	lines.push(
		`**Next step:** reply to this issue with feedback, or apply the \`${factoryConfig.labels.specApproved}\` label to approve.`,
	);

	return lines.join("\n");
}
