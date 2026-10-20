import { config } from "../../config/index.js";
import { Spec } from "../../schemas/index.js";
import { findMarkedComment, type GitHubClient, type IssueComment } from "../../github/index.js";
import { RunError } from "../../runs/index.js";

export type ApprovalGitHub = Pick<GitHubClient, "botLogin" | "listIssueComments" | "getLabelEvents">;

export interface ApprovedSpec {
	spec: Spec;
	comment: IssueComment;
	/** When the approval label was applied (ISO 8601). */
	approvedAt: string;
}

/**
 * The spec as it stood when the approval label was applied (invariant 9). The approval time is the newest
 * `labeled` event for the label, or the time the webhook reported when the timeline doesn't have it yet.
 */
export async function loadApprovedSpec(gh: ApprovalGitHub, issue: number, labeledAt: string): Promise<ApprovedSpec> {
	const label = config.labels.specApproved;
	const found = findMarkedComment(await gh.listIssueComments(issue), "spec", await gh.botLogin());
	if (!found) {
		throw new RunError(
			`there is no spec on this issue. Add the \`${config.labels.triage}\` label to draft one, then approve it with \`${label}\`.`,
			"no_spec",
		);
	}

	const events = await gh.getLabelEvents(issue, label);
	const approvedAt = events.at(-1)?.createdAt ?? labeledAt;
	if (Date.parse(found.comment.updatedAt) > Date.parse(approvedAt)) {
		throw new RunError(
			`the spec changed after it was approved. Review it and reapply the \`${label}\` label.`,
			"spec_changed",
		);
	}

	const parsed = Spec.safeParse(found.data.spec);
	if (!parsed.success) {
		throw new RunError(
			`the spec comment doesn't hold a valid spec. Add the \`${config.labels.triage}\` label to redraft it.`,
			"invalid_spec",
		);
	}
	return { spec: parsed.data, comment: found.comment, approvedAt };
}
