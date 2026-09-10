import type { Issue, IssueComment, RepoSnapshot } from "../github/index.js";

const MAX_ISSUE_CHARS = 12_000;
const MAX_BRIEF_CHARS = 8_000;

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

/**
 * The repository, described for an agent that has no checkout.
 *
 * Triage gates the run before a sandbox exists, and without this it treats
 * every fact about the codebase as a missing requirement and asks the
 * maintainer about it.
 */
export function repoBrief(fullName: string, snapshot: RepoSnapshot): string {
	const sections = [
		`# Repository: ${fullName}`,
		`Default branch: ${snapshot.defaultBranch}`,
		"",
		snapshot.truncated
			? `## Files (first ${snapshot.paths.length}, truncated)`
			: `## Files (${snapshot.paths.length})`,
		...snapshot.paths,
	];

	for (const file of snapshot.files) {
		sections.push("", `## ${file.path}`, file.content);
	}

	return sections.join("\n").slice(0, MAX_BRIEF_CHARS);
}
