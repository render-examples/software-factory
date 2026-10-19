import type { TaskContext } from "@renderinc/sdk/workflows";
import { task } from "@renderinc/sdk/workflows";
import { runAgent } from "../../agents/index.js";
import { requireRepo, TASKS } from "../../config/index.js";
import type { Review } from "../../contracts/index.js";
import { PrReviewInput } from "../../contracts/tasks.js";
import { type GitHubClient, githubFor } from "../../github/index.js";
import { PhaseError, type PhaseOutcome, type PhaseResult, type RunControl, subjectName, withPhase } from "../../phases/index.js";
import { openSandbox } from "../../sandbox/index.js";
import { failureReason, type RunAgent, runSpecialists, SPECIALIST_NAMES, synthesize } from "./agents.js";
import { headMoved, mergeBase, type OpenSandbox, withPullSandbox } from "./checkout.js";
import { commentable, pullDiffLines } from "./diff-lines.js";
import { specialistMessage, synthesizerMessage } from "./messages.js";
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
 * PR Reviewer: verify the PR head, run the four specialists in parallel in one sandbox, merge their findings
 * in this task, and post one COMMENT review. It never approves or requests changes.
 */
export async function runPrReview(ctx: Pick<TaskContext, "metadata">, raw: unknown, deps: PrReviewDeps = {}): Promise<PhaseOutcome> {
	const input = PrReviewInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId);
	const gh = deps.gh ?? githubFor(repo);
	const open = deps.openSandbox ?? ((r, ref) => openSandbox(r, ref));
	const run = deps.runAgent ?? runAgent;
	const subject = { kind: "pr", number: input.pr } as const;
	const phase = {
		repo,
		subject,
		phase: TASKS.prReview,
		actor: input.actor,
		gh,
		runs: deps.runs,
	};

	return withPhase(ctx, phase, async ({ traceId, runId, budget, progress }): Promise<PhaseResult> => {
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

		// 2. One sandbox at the PR head: verify, then the specialists in parallel. Closed before synthesis.
		await progress("opening a sandbox");
		const { verify, found } = await withPullSandbox(open, repo, pull, async (sandbox) => {
			const baseRef = await mergeBase(sandbox, pull.baseRef);
			await progress("running the verify commands");
			const verify = await runVerify(sandbox, repo.config.verify);

			await progress(`reviewing with ${SPECIALIST_NAMES.length} specialists`);
			const found = await runSpecialists(run, {
				sandbox,
				message: specialistMessage(pull, files, verify),
				vars: { repo: repo.fullName, baseRef },
				budget,
				base,
			});
			return { verify, found };
		});
		if (found.missing.length === SPECIALIST_NAMES.length) {
			throw new PhaseError("none of the specialist reviewers finished, so there's no review to post.", "no_reports");
		}

		// 3. The synthesizer merges the reports, in this task: it has no tools, so no sandbox.
		await progress("merging the specialists' findings");
		let review: Review;
		try {
			review = await synthesize(run, {
				message: synthesizerMessage(pull, verify, found.reports, found.missing),
				repo: repo.fullName,
				budget,
				base,
			});
		} catch (err) {
			throw new PhaseError(`the synthesizer ${failureReason(err)}, so no review was posted.`, "synthesis_failed");
		}

		// 4. One COMMENT review on the head commit. Comments GitHub can't place inline go in the body.
		await progress("posting the review");
		const { posted, inlineComments } = await postReview(gh, {
			pr: input.pr,
			headSha: input.headSha,
			runId,
			review,
			render: {
				verification: verify,
				missing: found.missing,
				isCommentable: commentable(diffLines),
			},
		});

		const failedVerify = verify.filter((v) => !v.passed).length;
		const notes = [
			`risk **${review.riskTier}**`,
			`${inlineComments} inline comment${inlineComments === 1 ? "" : "s"}`,
			...(failedVerify > 0 ? [`${failedVerify} of ${verify.length} verify commands failed`] : []),
			...(found.missing.length > 0 ? [`${found.missing.length} reviewer${found.missing.length === 1 ? "" : "s"} didn't finish`] : []),
		];
		return {
			outcome: "reviewed",
			summary: `posted a COMMENT review: ${notes.join(", ")}.`,
			links: [{ label: "Review", url: posted.htmlUrl }],
		};
	});
}

/** Not retried: specialists cost real money, and a relabel starts a fresh review. */
export const prReview = task(
	{
		name: TASKS.prReview,
		timeoutSeconds: 2 * 60 * 60,
		retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 },
	},
	(ctx, raw: unknown) => runPrReview(ctx, raw),
);
