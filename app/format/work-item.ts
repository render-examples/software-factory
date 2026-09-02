import type { Issue, IssueComment } from "../github/index.js";

const MAX_ISSUE_CHARS = 12_000;

/**
 * Flatten an issue and its comments into the work item agents receive.
 * Bounded, because issue threads are unbounded user input.
 */
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
