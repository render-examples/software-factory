/** spec-to-pr — labeled issue to reviewed draft pull request. */
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { repository, triggerLabel } from "../../config/index.js";
import {
	type WorkflowResult,
	workflowInputSchema,
} from "../../contracts/index.js";
import {
	changesRequestedComment,
	clarificationComment,
	draftPrComment,
	noChangesComment,
	pullRequestBody,
	verifyFailedComment,
} from "../../format/index.js";
import {
	branchName,
	completeDiff,
	setupCheckout,
	verifyPush,
} from "../../git/index.js";
import {
	githubFromEnv,
	githubToken,
	type RepoRef,
} from "../../github/index.js";
import { createSandbox } from "../../sandbox/index.js";
import { analysisTask } from "../../tasks/index.js";
import { finishRun, setRunStage } from "../../store/index.js";
import { MAX_VERIFY_ROUNDS, SANDBOX_TIMEOUT_SECONDS } from "./constants.js";
import {
	type ImplementationState,
	implementAndCommit,
	verifyWithFixes,
} from "./implement.js";
import { loadIntake } from "./intake.js";
import {
	clearStatusLabels,
	STATUS,
	type FactoryStatus,
	statusLabeler,
	terminalStatus,
} from "./labels.js";
import { commentId, recordOutcome } from "./outcome.js";
import { reviewDiff, runSelfReview } from "./review.js";

export const specToPr = task(
	{
		name: "spec-to-pr",
		plan: "standard",
		timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
	},
	async function specToPr(
		ctx: TaskContext,
		rawInput: unknown,
	): Promise<WorkflowResult> {
		const { issueNumber, runId } = workflowInputSchema.parse(rawInput);
		let setStatus: ((next: FactoryStatus) => Promise<void>) | undefined;

		try {
			const repo = repository();
			const gh = githubFromEnv();
			setStatus = statusLabeler(gh, repo, issueNumber);

			const result = await pipeline(ctx, issueNumber, runId, setStatus);
			await recordOutcome(runId, result);
			await setStatus(terminalStatus(result));

			// The trigger label comes off only once the run is genuinely over,
			// because reapplying it is how a maintainer retries.
			await gh
				.removeLabel(repo, issueNumber, triggerLabel())
				.catch((error) =>
					console.error("Failed to remove trigger label:", error),
				);
			return result;
		} catch (error) {
			const summary = error instanceof Error ? error.message : String(error);
			await finishRun(runId, "failed", {
				outcome: "error",
				summary: summary.slice(0, 1000),
			}).catch((storeError) =>
				console.error("Failed to record run failure:", storeError),
			);
			// Deliberately leave the trigger label in place: Render retries this
			// task, and the retry re-reads the issue. Removing it here would make
			// every retry fail at intake and mask the original error.
			await setStatus?.(STATUS.failed);
			throw error;
		}
	},
);

/** The pipeline. */
async function pipeline(
	ctx: TaskContext,
	issueNumber: number,
	runId: string,
	setStatus: (next: FactoryStatus) => Promise<void>,
): Promise<WorkflowResult> {
	const repo: RepoRef = repository();
	const label = triggerLabel();
	const gh = githubFromEnv();
	// Git needs a concrete token; under App auth this is an installation token.
	const token = await githubToken();

	// ── Intake ──────────────────────────────────────────────────────────
	const { issue, workItem, triage } = await loadIntake(
		ctx,
		gh,
		repo,
		issueNumber,
		label,
	);

	await clearStatusLabels(gh, repo, issueNumber, issue.labels);

	if (!triage.hasEnoughDetail) {
		const questions = triage.questions.length
			? triage.questions
			: [
					"What concrete outcome and acceptance criteria should the factory implement?",
				];
		await gh.ensureIssueComment(
			repo,
			issueNumber,
			commentId(runId, "clarification"),
			clarificationComment(questions, label),
		);
		return { status: "needs_clarification", questions };
	}

	// ── Sandbox ─────────────────────────────────────────────────────────
	const sandbox = await createSandbox({
		timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
	});
	try {
		const branch = branchName(issueNumber, runId);
		const checkout = await setupCheckout(sandbox, token, repo, branch);
		await setRunStage(runId, "implement");

		// ── Analysis ────────────────────────────────────────────────────
		await setStatus(STATUS.analyzing);
		const analysis = await ctx.run(analysisTask, {
			message: `Work item:\n${workItem}`,
			sandboxId: sandbox.id,
		});

		// ── Implementation ──────────────────────────────────────────────
		await setStatus(STATUS.implementing);
		const first = await implementAndCommit(ctx, {
			sandbox,
			checkout,
			previousSha: checkout.baseSha,
			stage: "implementer",
			commitMessage: `Implement issue #${issueNumber}: ${issue.title}`,
			prompt: `Work item:\n${workItem}\n\nApproved analysis:\n${analysis}`,
		});
		if (!first.sha) {
			await gh.ensureIssueComment(
				repo,
				issueNumber,
				commentId(runId, "no-changes"),
				noChangesComment(label),
			);
			return { status: "no_changes" };
		}
		let state: ImplementationState = {
			summary: first.summary,
			sha: first.sha,
		};

		// ── Verification ────────────────────────────────────────────────
		const verified = await verifyWithFixes(ctx, {
			sandbox,
			checkout,
			issueNumber,
			workItem,
			state,
		});
		if (!verified.passed) {
			await gh.ensureIssueComment(
				repo,
				issueNumber,
				commentId(runId, "verify-failed"),
				verifyFailedComment(verified.failures, MAX_VERIFY_ROUNDS, label),
			);
			return {
				status: "changes_requested",
				summary: `Verification failed: ${verified.failures.slice(0, 500)}`,
			};
		}
		state = verified.state;

		// ── Self-review ─────────────────────────────────────────────────
		const selfReview = await runSelfReview(
			ctx,
			await completeDiff(sandbox, checkout, state.sha),
			workItem,
		);
		if (selfReview.needsRevision && selfReview.issues.length > 0) {
			const issues = selfReview.issues
				.map((text, i) => `${i + 1}. ${text}`)
				.join("\n");
			const fix = await implementAndCommit(ctx, {
				sandbox,
				checkout,
				previousSha: state.sha,
				stage: "self-review-fix",
				commitMessage: `Self-review fixes for issue #${issueNumber}`,
				prompt:
					"Fix the following self-review issues. Do not restructure the implementation.\n\n" +
					`Work item:\n${workItem}\n\nIssues:\n${issues}`,
			});
			state = { summary: fix.summary, sha: fix.sha ?? state.sha };
		}

		// ── Review ──────────────────────────────────────────────────────
		await setStatus(STATUS.reviewing);
		let review = await reviewDiff(
			ctx,
			await completeDiff(sandbox, checkout, state.sha),
			state.summary,
		);

		// One revision round. If the judge still objects, stop and report.
		if (review.decision === "request_changes") {
			const revision = await implementAndCommit(ctx, {
				sandbox,
				checkout,
				previousSha: state.sha,
				stage: "revision",
				commitMessage: `Address internal review for issue #${issueNumber}`,
				prompt:
					`Revise the existing implementation.\n\nWork item:\n${workItem}\n\n` +
					`Blocking internal review:\n${review.summary}\n\n${review.details}`,
			});
			if (revision.sha) {
				state = { summary: revision.summary, sha: revision.sha };
				review = await reviewDiff(
					ctx,
					await completeDiff(sandbox, checkout, state.sha),
					state.summary,
				);
			} else {
				review = { ...review, summary: "The revision produced no changes." };
			}
		}

		if (review.decision !== "approve") {
			await gh.ensureIssueComment(
				repo,
				issueNumber,
				commentId(runId, "changes-requested"),
				changesRequestedComment(review.summary, label),
			);
			return { status: "changes_requested", summary: review.summary };
		}

		// ── Push and open the draft PR ──────────────────────────────────
		await verifyPush(sandbox, token, checkout, state.sha);
		const pull = await gh.ensurePull(repo, {
			title: `Fix #${issueNumber}: ${issue.title}`,
			head: checkout.branch,
			base: checkout.base,
			expectedHeadSha: state.sha,
			body: pullRequestBody(issueNumber, review, state.summary),
		});
		await gh.ensureIssueComment(
			repo,
			issueNumber,
			commentId(runId, "draft-pr"),
			draftPrComment(pull.htmlUrl),
		);

		return { status: "draft_pr_opened", pullRequest: pull.htmlUrl };
	} finally {
		await sandbox
			.terminate()
			.catch((error) =>
				console.error("Failed to terminate sandbox:", error),
			);
	}
}
