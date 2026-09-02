/** spec-to-pr — labeled issue to reviewed draft pull request. */
import { task } from "@renderinc/sdk/workflows";
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
import { githubFromEnv, type RepoRef } from "../../github/index.js";
import { createSandbox } from "../../sandbox/index.js";
import { analysisTask } from "../../tasks/index.js";
import { finishRun, setRunBranch } from "../../store/index.js";
import { MAX_VERIFY_ROUNDS, SANDBOX_TIMEOUT_SECONDS } from "./constants.js";
import {
	type ImplementationState,
	implementAndCommit,
	verifyWithFixes,
} from "./implement.js";
import { loadIntake } from "./intake.js";
import { commentId, recordOutcome } from "./outcome.js";
import { reviewDiff, runSelfReview } from "./review.js";

export const specToPr = task(
	{
		name: "spec-to-pr",
		plan: "standard",
		timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
	},
	async function specToPr(rawInput: unknown): Promise<WorkflowResult> {
		const { issueNumber, runId } = workflowInputSchema.parse(rawInput);
		try {
			const result = await run(issueNumber, runId);
			await recordOutcome(runId, result);
			return result;
		} catch (error) {
			const summary = error instanceof Error ? error.message : String(error);
			await finishRun(runId, "failed", {
				summary: summary.slice(0, 1000),
			}).catch((storeError) =>
				console.error("Failed to record run failure:", storeError),
			);
			throw error;
		}
	},
);

/** The pipeline. Read this top to bottom. */
async function run(
	issueNumber: number,
	runId: string,
): Promise<WorkflowResult> {
	const repo: RepoRef = repository();
	const label = triggerLabel();
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is not set");
	const gh = githubFromEnv();

	// ── Intake ──────────────────────────────────────────────────────────
	const { issue, workItem, triage } = await loadIntake(
		gh,
		repo,
		issueNumber,
		label,
	);

	await gh.removeLabel(repo, issueNumber, label);

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
		await setRunBranch(runId, branch);

		// ── Analysis ────────────────────────────────────────────────────
		const analysis = await analysisTask({
			message: `Work item:\n${workItem}`,
			sandboxId: sandbox.id,
		});

		// ── Implementation ──────────────────────────────────────────────
		const first = await implementAndCommit({
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
		let state: ImplementationState = { summary: first.summary, sha: first.sha };

		// ── Verification ────────────────────────────────────────────────
		const verified = await verifyWithFixes({
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
			await completeDiff(sandbox, checkout, state.sha),
			workItem,
		);
		if (selfReview.needsRevision && selfReview.issues.length > 0) {
			const issues = selfReview.issues
				.map((text, i) => `${i + 1}. ${text}`)
				.join("\n");
			const fix = await implementAndCommit({
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
		let review = await reviewDiff(
			await completeDiff(sandbox, checkout, state.sha),
			state.summary,
		);

		// One revision round. If the judge still objects, stop and report.
		if (review.decision === "request_changes") {
			const revision = await implementAndCommit({
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
			.catch((error) => console.error("Failed to terminate sandbox:", error));
	}
}
