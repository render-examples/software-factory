/** spec-to-pr — approved specification to reviewed draft pull request. */
import { randomUUID } from "node:crypto";
import { factoryConfig } from "../../../factory.config.js";
import { repository, target } from "../../config/index.js";
import {
	draftPrComment,
	noChangesComment,
	noSpecComment,
	approvalRefusedComment,
	publishRefusedComment,
	pullRequestBody,
	specWorkItem,
	verifyFailedComment,
} from "../../format/index.js";
import {
	branchName,
	completeDiff,
	setupBranch,
	type CommandResult,
} from "../../git/index.js";
import { gitDataClient, type RepoRef } from "../../github/index.js";
import { publish } from "../../publish/index.js";
import { mergeRunResult } from "../../store/index.js";
import { lease, release } from "../../workspaces/index.js";
import { type LifecycleResult, runWorkflow } from "../lifecycle.js";
import { STATUS } from "../labels.js";
import { SANDBOX_TIMEOUT_SECONDS } from "./constants.js";
import {
	type ImplementationState,
	implementAndCommit,
	verifyWithFixes,
} from "./implement.js";
import { loadSpecIntake } from "./intake.js";
import { runSelfReview } from "./review.js";

function commentId(runId: string, operation: string): string {
	return `${runId.slice(0, 64)}-${operation}`;
}

export const specToPr = runWorkflow(
	"spec-to-pr",
	{ timeoutSeconds: SANDBOX_TIMEOUT_SECONDS },
	async (lc): Promise<LifecycleResult> => {
		const { ctx, run, gh, stage, setStatus, throwIfCancelled, defer } = lc;
		const repo: RepoRef = repository();
		const runId = run.id;
		const issueNumber = run.subjectNumber;
		const trigger = run.trigger as Record<string, unknown> | null;
		const triggerLabel = trigger?.label as string | undefined;
		const runInput = (run.input ?? {}) as Record<string, unknown>;
		const specId = (runInput.specId as string) ?? null;
		const specVersion = runInput.specVersion as number | null | undefined;
		const autoAdvance = runInput.autoAdvance === true;
		const actorLogin = (trigger?.actor as { login?: string })?.login ?? "";

		// ── Intake ──────────────────────────────────────────────────────
		await stage("intake");

		const intake = await loadSpecIntake(specId, specVersion, actorLogin);
		if (!intake.ok) {
			const body =
				intake.outcome === "no_spec" && !specId
					? noSpecComment()
					: approvalRefusedComment(intake.detail);
			return {
				status: "completed",
				outcome: intake.outcome,
				result: { detail: intake.detail },
				comment: {
					body,
					operationId: commentId(runId, "no-spec"),
				},
				removeLabels: [
					...(triggerLabel ? [triggerLabel] : []),
					factoryConfig.labels.triage,
					factoryConfig.labels.fullRun,
				],
			};
		}

		const { spec, specVersion: specVer, specRecord } = intake.intake;

		// Remove conversation labels
		const conversationLabels = [
			factoryConfig.labels.triage,
			factoryConfig.labels.fullRun,
		];

		const workItem = specWorkItem(spec);

		await throwIfCancelled();

		// ── Workspace ───────────────────────────────────────────────────
		await stage("workspace");
		const workspace = await lease(runId, {
			kind: "branch",
			name: target().baseBranch,
		});
		defer(async () => {
			await release(runId);
		});

		const branch = branchName(issueNumber, runId);
		const checkout = await setupBranch(
			workspace.sandbox,
			branch,
			workspace.baseSha,
			workspace.baseBranch,
		);

		await mergeRunResult(runId, { branch, baseSha: workspace.baseSha });

		await throwIfCancelled();

		// ── Implement ───────────────────────────────────────────────────
		await stage("implement");
		await setStatus(STATUS.implementing);

		const first = await implementAndCommit(ctx, {
			runId,
			sandbox: workspace.sandbox,
			checkout,
			previousSha: checkout.baseSha,
			stage: "implementer",
			commitMessage: `Implement: ${spec.title} (#${issueNumber})`,
			prompt: `Specification:\n${workItem}`,
		});

		if (!first.sha) {
			return {
				status: "completed",
				outcome: "no_changes",
				comment: {
					body: noChangesComment(),
					operationId: commentId(runId, "no-changes"),
				},
				removeLabels: [
					...(triggerLabel ? [triggerLabel] : []),
					...conversationLabels,
				],
			};
		}

		let state: ImplementationState = {
			summary: first.summary,
			sha: first.sha,
		};

		// ── Verify ──────────────────────────────────────────────────────
		await stage("verify");
		const verified = await verifyWithFixes(ctx, {
			runId,
			sandbox: workspace.sandbox,
			checkout,
			issueNumber,
			workItem,
			state,
		});

		if (!verified.passed) {
			return {
				status: "completed",
				outcome: "verification_failed",
				result: {
					summary: `Verification failed: ${verified.failures.slice(0, 500)}`,
				},
				comment: {
					body: verifyFailedComment(
						verified.failures,
						factoryConfig.limits.repairRounds,
					),
					operationId: commentId(runId, "verify-failed"),
				},
				removeLabels: [
					...(triggerLabel ? [triggerLabel] : []),
					...conversationLabels,
				],
			};
		}
		state = verified.state;
		const verificationResults: CommandResult[] = verified.results;

		await throwIfCancelled();

		// ── Self-review ─────────────────────────────────────────────────
		await stage("self-review");
		const selfReview = await runSelfReview(
			ctx,
			await completeDiff(workspace.sandbox, checkout, state.sha),
			workItem,
			runId,
		);

		let selfReviewNotes: string[] = [];
		if (selfReview.needsRevision && selfReview.issues.length > 0) {
			const issues = selfReview.issues
				.map((text, i) => `${i + 1}. ${text}`)
				.join("\n");
			const fix = await implementAndCommit(ctx, {
				runId,
				sandbox: workspace.sandbox,
				checkout,
				previousSha: state.sha,
				stage: "self-review-fix",
				commitMessage: `Self-review fixes for #${issueNumber}`,
				prompt:
					"Fix the following self-review issues. Do not restructure the implementation.\n\n" +
					`Specification:\n${workItem}\n\nIssues:\n${issues}`,
			});
			state = { summary: fix.summary, sha: fix.sha ?? state.sha };

			// Re-verify after self-review fix
			const reVerify = await verifyWithFixes(ctx, {
				runId,
				sandbox: workspace.sandbox,
				checkout,
				issueNumber,
				workItem,
				state,
			});
			if (!reVerify.passed) {
				selfReviewNotes = selfReview.issues;
			} else {
				state = reVerify.state;
			}
		} else if (selfReview.issues.length > 0) {
			selfReviewNotes = selfReview.issues;
		}

		await throwIfCancelled();

		// ── Publish ─────────────────────────────────────────────────────
		await stage("publish");
		const authorDate = new Date().toISOString();

		const published = await publish({
			sandbox: workspace.sandbox,
			gitData: gitDataClient(),
			baseSha: workspace.baseSha,
			branch,
			message: `${spec.title} (#${issueNumber})`,
			authorDate,
		});

		if (!published.ok) {
			const detail = published.reasons.map((r) => r.detail).join("; ");
			return {
				status: "completed",
				outcome: "publish_refused",
				result: { detail },
				comment: {
					body: publishRefusedComment(detail),
					operationId: commentId(runId, "publish-refused"),
				},
				removeLabels: [
					...(triggerLabel ? [triggerLabel] : []),
					...conversationLabels,
				],
			};
		}

		// ── Pull request ────────────────────────────────────────────────
		await stage("pull-request");
		let currentBaseTip: string | undefined;
		try {
			currentBaseTip = await gh.getBranchTipSha(repo, target().baseBranch);
		} catch {
			/* non-fatal */
		}

		const prBody = pullRequestBody({
			issueNumber,
			spec,
			summary: state.summary,
			selfReviewNotes,
			verificationResults,
			runId,
			specId,
			specVersion: specVer.version,
			specCommentId: specRecord.commentId,
			baseSha: workspace.baseSha,
			currentBaseTip,
		});

		const pull = await gh.ensurePull(repo, {
			title: `${spec.title} (#${issueNumber})`,
			head: branch,
			base: target().baseBranch,
			expectedHeadSha: published.result.commitSha,
			body: prBody,
		});

		// Comment on the issue with the PR link
		const prResult = {
			prNumber: pull.number,
			prUrl: pull.htmlUrl,
			headSha: published.result.commitSha,
			branch,
		};

		// ── Complete ────────────────────────────────────────────────────
		const followUp = autoAdvance
			? {
					id: randomUUID(),
					repo: `${repo.owner}/${repo.repo}`,
					subjectKind: "pull_request" as const,
					subjectNumber: pull.number,
					workflow: "pr-review",
					trigger: run.trigger ?? undefined,
					input: {
						prNumber: pull.number,
						headSha: published.result.commitSha,
					},
					previousRunId: runId,
				}
			: undefined;

		return {
			status: "completed",
			outcome: "pr_opened",
			result: prResult,
			comment: {
				body: draftPrComment(pull.htmlUrl),
				operationId: commentId(runId, "draft-pr"),
			},
			followUp,
			removeLabels: [
				...(triggerLabel ? [triggerLabel] : []),
				...conversationLabels,
			],
		};
	},
);
