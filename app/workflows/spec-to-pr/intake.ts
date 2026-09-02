import { type Triage, triageSchema } from "../../contracts/index.js";
import { workItem as buildWorkItem } from "../../format/index.js";
import type { GitHub, Issue, RepoRef } from "../../github/index.js";
import { triageTask } from "../../tasks/index.js";
import { agentJson } from "../agent-json.js";

export interface Intake {
	issue: Issue;
	/** The issue and its comments, flattened and bounded. */
	workItem: string;
	triage: Triage;
}

/**
 * Fetch authoritative state and decide whether the issue is actionable.
 *
 * The gateway sends only an issue number, so everything is read here — and the
 * label is re-checked because it may have been removed since the webhook.
 */
export async function loadIntake(
	gh: GitHub,
	repo: RepoRef,
	issueNumber: number,
	label: string,
): Promise<Intake> {
	const issue = await gh.getIssue(repo, issueNumber);
	if (!issue.labels.includes(label)) {
		throw new Error(`Issue no longer has the "${label}" label`);
	}

	const comments = await gh.listIssueComments(repo, issueNumber);
	const workItem = buildWorkItem(issue, comments);
	const triage = await agentJson(
		(message) => triageTask({ message }),
		triageSchema,
		workItem,
		"triage",
	);

	return { issue, workItem, triage };
}
