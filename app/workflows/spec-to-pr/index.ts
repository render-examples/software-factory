/** spec-to-pr — labeled issue to reviewed draft pull request. */
import { repository } from "../../config/index.js";
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
import { githubToken, type RepoRef } from "../../github/index.js";
import { createSandbox } from "../../sandbox/index.js";
import { mergeRunResult } from "../../store/index.js";
import { analysisTask } from "../../tasks/index.js";
import { type LifecycleResult, runWorkflow } from "../lifecycle.js";
import { MAX_VERIFY_ROUNDS, SANDBOX_TIMEOUT_SECONDS } from "./constants.js";
import {
	type ImplementationState,
	implementAndCommit,
	verifyWithFixes,
} from "./implement.js";
import { loadIntake } from "./intake.js";
import { clearStatusLabels, STATUS } from "./labels.js";
import { reviewDiff, runSelfReview } from "./review.js";

function commentId(runId: string, operation: string): string {
	return `${runId.slice(0, 64)}-${operation}`;
}

export const specToPr = runWorkflow(
	"spec-to-pr",
	{ timeoutSeconds: SANDBOX_TIMEOUT_SECONDS },
	async (lc): Promise<LifecycleResult> => {
		const { ctx, run, gh, setStatus, throwIfCancelled, defer } = lc;
		const repo: RepoRef = repository();
		const runId = run.id;
		const issueNumber = run.subjectNumber;
		const triggerLabel = (run.trigger as Record<string, unknown> | null)
			?.label as string | undefined;
		const label = triggerLabel ?? "";
		const token = await githubToken();

		// ── Intake ──────────────────────────────────────────────────────
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
			return {
				status: "completed",
				outcome: "needs_clarification",
				result: { questions },
				comment: {
					body: clarificationComment(questions, label),
					operationId: commentId(runId, "clarification"),
				},
				removeLabels: triggerLabel ? [triggerLabel] : [],
			};
		}

		// ── Sandbox ─────────────────────────────────────────────────────
		const sandbox = await createSandbox({
			timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
		});
		defer(async () => {
			await sandbox
				.terminate()
				.catch((error: unknown) =>
					console.error("Failed to terminate sandbox:", error),
				);
		});

		const branch = branchName(issueNumber, runId);
		const checkout = await setupCheckout(sandbox, token, repo, branch);
		await mergeRunResult(runId, { branch });

		await throwIfCancelled();

		// ── Analysis ────────────────────────────────────────────────────
		await setStatus(STATUS.analyzing);
		const analysis = await ctx.run(analysisTask, {
			message: `Work item:\n${workItem}`,
			sandboxId: sandbox.id,
		});

		await throwIfCancelled();

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
			return {
				status: "completed",
				outcome: "no_changes",
				comment: {
					body: noChangesComment(label),
					operationId: commentId(runId, "no-changes"),
				},
				removeLabels: triggerLabel ? [triggerLabel] : [],
			};
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
			return {
				status: "completed",
				outcome: "changes_requested",
				result: {
					summary: `Verification failed: ${verified.failures.slice(0, 500)}`,
				},
				comment: {
					body: verifyFailedComment(
						verified.failures,
						MAX_VERIFY_ROUNDS,
						label,
					),
					operationId: commentId(runId, "verify-failed"),
				},
				removeLabels: triggerLabel ? [triggerLabel] : [],
			};
		}
		state = verified.state;

		await throwIfCancelled();

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

		await throwIfCancelled();

		// ── Review ──────────────────────────────────────────────────────
		await setStatus(STATUS.reviewing);
		let review = await reviewDiff(
			ctx,
			await completeDiff(sandbox, checkout, state.sha),
			state.summary,
		);

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
			return {
				status: "completed",
				outcome: "changes_requested",
				result: { summary: review.summary },
				comment: {
					body: changesRequestedComment(review.summary, label),
					operationId: commentId(runId, "changes-requested"),
				},
				removeLabels: triggerLabel ? [triggerLabel] : [],
			};
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

		return {
			status: "completed",
			outcome: "draft_pr_opened",
			result: { pullRequest: pull.htmlUrl, branch },
			comment: {
				body: draftPrComment(pull.htmlUrl),
				operationId: commentId(runId, "draft-pr"),
			},
			removeLabels: triggerLabel ? [triggerLabel] : [],
		};
	},
);
