import type { GitHubHttp } from "../../github/request.js";
import type { RepoRef } from "../../github/types.js";
import { ensureReview, type ReviewComment } from "../../github/pulls.js";

/**
 * Submit the COMMENT review via ensureReview.
 * The marker prevents duplicate reviews on retry.
 */
export async function submitReview(
	http: GitHubHttp,
	ref: RepoRef,
	opts: {
		runId: string;
		prNumber: number;
		headSha: string;
		body: string;
		comments: ReviewComment[];
	},
): Promise<{ id: number; alreadyExisted: boolean }> {
	const marker = `<!-- render-factory:review run=${opts.runId} -->`;
	return ensureReview(http, ref, opts.prNumber, {
		commitId: opts.headSha,
		body: opts.body,
		comments: opts.comments,
		marker,
	});
}
