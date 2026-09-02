import { createHash } from "node:crypto";
import type { WorkspaceInfo } from "#factory/sdk";
import type { Issue, IssueComment } from "../../lib/github.js";
import { MAX_ISSUE_CHARS } from "./constants.js";

export function issueContext(issue: Issue, comments: IssueComment[]): string {
	const sections = [`# ${issue.title}`, "", issue.body || "(no description)"];
	if (comments.length > 0) {
		sections.push("", "## Comments");
		for (const comment of comments) {
			sections.push(`### @${comment.user}`, comment.body);
		}
	}
	return sections.join("\n").slice(0, MAX_ISSUE_CHARS);
}

/** Tells the model where the checkout lives, derived from the environment. */
export function workspacePreamble(workspace: WorkspaceInfo): string {
	return `repoDir: ${workspace.repoDir}`;
}

export function operationId(runId: string, operation: string): string {
	return `${runId.slice(0, 64)}-${operation}`;
}

export function branchName(issueNumber: number, runId: string): string {
	const suffix = createHash("sha256")
		.update(runId)
		.digest("hex")
		.slice(0, 16);
	return `factory/issue-${issueNumber}-${suffix}`;
}
