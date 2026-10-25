import { prReviewer, runAgent } from "../../agents/index.js";
import type { Outcome } from "../../claims/index.js";
import { TASKS } from "../../config/index.js";
import { openSandbox } from "../../sandbox/index.js";
import { PrReviewInput } from "../../schemas/index.js";
import { defineGitHubTask, type GitHubTaskDeps } from "../github-task.js";
import { runVerify } from "../run-verify.js";
import { headMoved, mergeBase, type OpenSandbox, withPullSandbox } from "./checkout.js";
import { commentable, pullDiffLines } from "./diff-lines.js";
import { reviewerMessage } from "./messages.js";
import { findReview, postReview } from "./post.js";

/** Test seams: everything that reaches GitHub, Sandboxes, or a model. */
export interface PrReviewDeps extends GitHubTaskDeps {
	openSandbox?: OpenSandbox;
	runAgent?: typeof runAgent;
}

/**
 * PR Reviewer: verify the PR head, review it in one sandbox, and post one COMMENT review.
 * It never approves or requests changes.
 */
export const prReviewWorkflow = defineGitHubTask(
	{
		name: TASKS.prReview,
		title: "PR Reviewer",
		input: PrReviewInput,
		subject: (input, ctx) => {
			if (input.workflowIssue && !ctx.metadata.parentTaskRunId) throw new Error("workflowIssue is valid only in a parent workflow");
			return input.workflowIssue ? { kind: "issue", number: input.workflowIssue } : { kind: "pr", number: input.pr };
		},
		timeoutSeconds: 2 * 60 * 60,
	},
	async (claim, input, deps: PrReviewDeps): Promise<Outcome> => {
		const { gh, repo } = claim;

		// 1. The PR must be open, still at the labeled commit, and not yet reviewed there.
		const pull = await gh.getPull(input.pr);
		if (pull.state !== "open" || pull.merged) {
			return { outcome: "pr_closed", summary: "the pull request is closed, so there's nothing to review." };
		}
		if (pull.headSha !== input.headSha) throw headMoved();
		const existing = await findReview(gh, input.pr, input.headSha);
		if (existing) {
			return {
				outcome: "already_reviewed",
				summary: "this commit already has a factory review.",
				links: [{ label: "Review", url: existing.htmlUrl }],
			};
		}
		const files = await gh.listPullFiles(input.pr);
		const diffLines = await pullDiffLines(gh, input.pr, files);

		// 2. One sandbox at the PR head: verify, then review the complete change.
		await claim.progress("opening a sandbox");
		const { verify, review } = await withPullSandbox(deps.openSandbox ?? openSandbox, repo, pull, async (sandbox) => {
			await claim.recordSandbox(sandbox);
			const baseRef = await mergeBase(sandbox, pull.baseRef);
			await claim.progress("running the verify commands");
			const verify = await runVerify(sandbox, repo.config.verify);

			await claim.progress("reviewing the pull request");
			const message = reviewerMessage({ repo: repo.fullName, pull, baseRef, files, verify });
			const { output: review } = await (deps.runAgent ?? runAgent)(prReviewer, message, claim.agentOptions(sandbox));
			return { verify, review };
		});

		// 3. One COMMENT review on the head commit. Comments GitHub can't place inline go in the body.
		await claim.progress("posting the review");
		const { posted, inlineComments } = await postReview(gh, {
			pr: input.pr,
			headSha: input.headSha,
			runId: claim.runId,
			review,
			render: { verification: verify, isCommentable: commentable(diffLines) },
		});

		const failedVerify = verify.filter((v) => !v.passed).length;
		const notes = [
			`risk **${review.riskTier}**`,
			`${inlineComments} inline comment${inlineComments === 1 ? "" : "s"}`,
			...(failedVerify > 0 ? [`${failedVerify} of ${verify.length} verify commands failed`] : []),
		];
		return { outcome: "reviewed", summary: `posted a COMMENT review: ${notes.join(", ")}.`, links: [{ label: "Review", url: posted.htmlUrl }] };
	},
);

export const runPrReview = prReviewWorkflow.run;
