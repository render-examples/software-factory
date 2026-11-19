import { runAgent } from "../../agent-runs/index.js";
import { prReviewer } from "../../agents/index.js";
import { config, TASKS } from "../../config/index.js";
import type { Outcome } from "../../runs/index.js";
import { openSandbox } from "../../sandbox/index.js";
import { PrReviewInput } from "../../schemas/index.js";
import { defineGitHubTask, type GitHubTaskDeps } from "../github-task.js";
import { runVerify } from "../run-verify.js";
import { headMoved, mergeBase, type OpenSandbox, withPullSandbox } from "./checkout.js";
import { commentable, pullDiffLines } from "./diff-lines.js";
import { reviewerMessage } from "./messages.js";
import { findReview, postReview } from "./post.js";

export interface PrReviewDeps extends GitHubTaskDeps {
	openSandbox?: OpenSandbox;
	runAgent?: typeof runAgent;
}

export const prReviewWorkflow = defineGitHubTask(
	{
		name: TASKS.prReview,
		title: "PR Reviewer",
		input: PrReviewInput,
		thread: (input) => ({ kind: "pr", number: input.pr }),
		trigger: (input) => ({ label: config.labels.prReview, number: input.pr }),
		timeoutSeconds: 2 * 60 * 60,
	},
	async (run, input, deps: PrReviewDeps): Promise<Outcome> => {
		const { gh, repo } = run;

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

		await run.reportProgress("opening a sandbox");
		const { verify, review } = await withPullSandbox(deps.openSandbox ?? openSandbox, repo, pull, async (sandbox) => {
			await run.trackSandbox(sandbox);
			const baseRef = await mergeBase(sandbox, pull.baseRef);
			await run.reportProgress("running the verify commands");
			const verify = await runVerify(sandbox, repo.config.verify);

			await run.reportProgress("reviewing the pull request");
			const message = reviewerMessage({ repo: repo.fullName, pull, baseRef, files, verify });
			const { output: review } = await (deps.runAgent ?? runAgent)(prReviewer, message, run.agentRunOptions(sandbox));
			return { verify, review };
		});

		await run.reportProgress("posting the review");
		const { posted, inlineComments } = await postReview(gh, {
			pr: input.pr,
			headSha: input.headSha,
			runId: run.runId,
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
