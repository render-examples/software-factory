import type { Issue, IssueComment } from "../github/index.js";
import type { Spec } from "../contracts/index.js";

const MAX_ISSUE_CHARS = 12_000;

/** Flatten an issue and its comments into one bounded work item string. */
export function workItem(issue: Issue, comments: IssueComment[]): string {
	const sections = [`# ${issue.title}`, "", issue.body || "(no description)"];
	if (comments.length > 0) {
		sections.push("", "## Comments");
		for (const comment of comments) {
			sections.push(`### @${comment.user}`, comment.body);
		}
	}
	return sections.join("\n").slice(0, MAX_ISSUE_CHARS);
}

/** Render a spec as the work item for the implementer. */
export function specWorkItem(spec: Spec): string {
	const sections: string[] = [];

	sections.push(`# ${spec.title}`);
	sections.push("");
	sections.push(spec.summary);
	sections.push("");
	sections.push("## Problem");
	sections.push(spec.problem);
	sections.push("");
	sections.push("## Goals");
	for (const goal of spec.goals) {
		sections.push(`- ${goal}`);
	}
	if (spec.nonGoals.length > 0) {
		sections.push("");
		sections.push("## Non-goals");
		for (const ng of spec.nonGoals) {
			sections.push(`- ${ng}`);
		}
	}
	sections.push("");
	sections.push("## Acceptance criteria");
	for (const ac of spec.acceptanceCriteria) {
		sections.push(`- **${ac.id}**: ${ac.text} (${ac.verification})`);
	}
	sections.push("");
	sections.push("## Approach");
	sections.push(spec.approach);
	if (spec.affectedAreas.length > 0) {
		sections.push("");
		sections.push("## Affected areas");
		for (const area of spec.affectedAreas) {
			sections.push(`- \`${area.path}\`: ${area.change}`);
		}
	}
	sections.push("");
	sections.push("## Test plan");
	sections.push(spec.testPlan);
	if (spec.risks.length > 0) {
		sections.push("");
		sections.push("## Risks");
		for (const risk of spec.risks) {
			sections.push(`- ${risk}`);
		}
	}

	return sections.join("\n");
}
