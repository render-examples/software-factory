import type { RefusalReason } from "../../changeset/index.js";
import { sanitizeInline } from "../../format/index.js";
import type { GitDataClient, GitHubClient, GitIdentity } from "../../github/index.js";
import { ExpectedFailure } from "../../runs/index.js";
import type { Spec } from "../../schemas/index.js";

export const branchName = (issue: number): string => `factory/issue-${issue}`;

export function commitMessage(spec: Spec, issue: number): string {
	return `${spec.title.replace(/\s+/g, " ").trim()}\n\nRefs #${issue}`;
}

export function commitDate(now: Date): string {
	return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function botIdentity(gh: Pick<GitHubClient, "botLogin" | "http">, date: string): Promise<GitIdentity> {
	const login = await gh.botLogin();
	const user = await gh.http.json<{ id: number }>("GET", `/users/${encodeURIComponent(login)}`);
	if (!Number.isInteger(user?.id)) throw new Error(`GET /users/${login} returned no id`);
	return { name: login, email: `${user.id}+${login}@users.noreply.github.com`, date };
}

export async function ownedCommits(git: GitDataClient, branch: string, baseSha: string, bot: GitIdentity): Promise<string[]> {
	const tip = await git.getRef(branch);
	if (tip === null || tip === baseSha) return [];
	const commit = await git.getCommit(tip);
	const committer = commit.committer;
	const ours = committer?.name === bot.name && committer.email.toLowerCase() === bot.email.toLowerCase() && commit.parents.length === 1;
	if (!ours) {
		throw new ExpectedFailure(
			`the branch \`${branch}\` has commits the factory didn't make, so it was left alone. Delete or rename the branch and reapply the label to retry.`,
			"branch_taken",
		);
	}
	return [tip];
}

export function refusalSummary(refused: readonly RefusalReason[]): string {
	const shown = refused.slice(0, 10).map((r) => sanitizeInline(r.detail));
	const more = refused.length > shown.length ? `; and ${refused.length - shown.length} more` : "";
	return `publishing refused the change: ${shown.join("; ")}${more}.`;
}
