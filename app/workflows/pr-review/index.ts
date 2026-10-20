import type { TaskContext } from "@renderinc/sdk/workflows";
import { task } from "@renderinc/sdk/workflows";
import { runAgent } from "../../agents/index.js";
import { requireRepo, TASKS } from "../../config/index.js";
import { PrReviewInput } from "../../contracts/tasks.js";
import { type GitHubClient, githubFor } from "../../github/index.js";
import { RunError, type RunOutcome, type RunResult, type RunControl, subjectName, withRun } from "../../runs/index.js";
import { openSandbox } from "../../sandbox/index.js";
import { failureReason, reviewPull, type RunAgent } from "./agents.js";
import { headMoved, mergeBase, type OpenSandbox, withPullSandbox } from "./checkout.js";
import { commentable, pullDiffLines } from "./diff-lines.js";
import { reviewerMessage } from "./messages.js";
import { findReview, postReview } from "./post.js";
import { runVerify } from "./verify.js";

/** Test seams: everything that reaches GitHub, Sandboxes, or a model. */
export interface PrReviewDeps {
	gh?: GitHubClient;
	runs?: RunControl;
	openSandbox?: OpenSandbox;
	runAgent?: RunAgent;
}

/**
 * PR Reviewer: verify the PR head, review it in one sandbox, and post one COMMENT review.
 * It never approves or requests changes.
 */
export async function runPrReview(ctx: Pick<TaskContext, "metadata">, raw: unknown, deps: PrReviewDeps = {}): Promise<RunOutcome> {
	const input = PrReviewInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId);
	const gh = deps.gh ?? githubFor(repo);
	const open = deps.openSandbox ?? ((r, ref) => openSandbox(r, ref));
	const run = deps.runAgent ?? runAgent;
	const subject = { kind: "pr", number: input.pr } as const;
	const stage = {
		repo,
		subject,
		stage: TASKS.prReview,
		actor: input.actor,
		gh,
		runs: deps.runs,
	};

	return withRun(ctx, stage, async ({ traceId, runId, budget, progress }): Promise<RunResult> => {
		const base = {
			traceId,
			runId,
			repo: repo.fullName,
			subject: subjectName(subject),
		};

		// 1. The PR must be open, still at the labeled commit, and not yet reviewed there.
		const pull = await gh.getPull(input.pr);
		if (pull.state !== "open" || pull.merged) {
			return {
				outcome: "pr_closed",
				summary: "the pull request is closed, so there's nothing to review.",
			};
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
		await progress("opening a sandbox");
		const { verify, review } = await withPullSandbox(open, repo, pull, async (sandbox) => {
			const baseRef = await mergeBase(sandbox, pull.baseRef);
			await progress("running the verify commands");
			const verify = await runVerify(sandbox, repo.config.verify);

			await progress("reviewing the pull request");
			try {
				const review = await reviewPull(run, {
					sandbox,
					message: reviewerMessage(pull, files, verify),
					vars: { repo: repo.fullName, baseRef },
					budget,
					base,
				});
				return { verify, review };
			} catch (err) {
				throw new RunError(`the PR reviewer ${failureReason(err)}, so no review was posted.`, "review_failed");
			}
		});

		// 3. One COMMENT review on the head commit. Comments GitHub can't place inline go in the body.
		await progress("posting the review");
		const { posted, inlineComments } = await postReview(gh, {
			pr: input.pr,
			headSha: input.headSha,
			runId,
			review,
			render: {
				verification: verify,
				isCommentable: commentable(diffLines),
			},
		});

		const failedVerify = verify.filter((v) => !v.passed).length;
		const notes = [
			`risk **${review.riskTier}**`,
			`${inlineComments} inline comment${inlineComments === 1 ? "" : "s"}`,
			...(failedVerify > 0 ? [`${failedVerify} of ${verify.length} verify commands failed`] : []),
		];
		return {
			outcome: "reviewed",
			summary: `posted a COMMENT review: ${notes.join(", ")}.`,
			links: [{ label: "Review", url: posted.htmlUrl }],
		};
	});
}

/** Not retried: review costs real money, and a relabel starts a fresh review. */
export const prReview = task(
	{
		name: TASKS.prReview,
		timeoutSeconds: 2 * 60 * 60,
		retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 },
	},
	(ctx, raw: unknown) => runPrReview(ctx, raw),
);
