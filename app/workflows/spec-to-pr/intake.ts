import { type Triage, triageSchema } from "../../contracts/index.js";
import {
	repoBrief,
	workItem as buildWorkItem,
} from "../../format/index.js";
import type { GitHub, Issue, RepoRef } from "../../github/index.js";
import { triageTask } from "../../tasks/index.js";
import { agentJson } from "../agent-json.js";

export interface Intake {
	issue: Issue;
	workItem: string;
	triage: Triage;
}

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

	// Triage runs before the sandbox, so it gets the repository described
	// rather than checked out. Losing this must not fail the run: the analyst
	// reads the real thing a moment later.
	const brief = await gh
		.getRepoSnapshot(repo)
		.then((snapshot) => repoBrief(`${repo.owner}/${repo.repo}`, snapshot))
		.catch((error) => {
			console.error("Failed to build the repository brief:", error);
			return "# Repository: not available\n";
		});

	const triage = await agentJson(
		(message) => triageTask({ message }),
		triageSchema,
		`${brief}\n\n---\n\n# Work item\n\n${workItem}`,
		"triage",
	);

	return { issue, workItem, triage };
}
