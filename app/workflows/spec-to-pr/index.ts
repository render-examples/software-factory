/** One-repository factory: labeled issue → analysis → implementation → review → draft PR. */
import { randomUUID } from "node:crypto";
import { task } from "@renderinc/sdk/workflows";
import {
	factoryStore,
	type ExecutionHandle,
} from "#factory/store";
import { RenderSandboxProvider, type Sandbox } from "#factory/sdk";
import { factoryLabel, factoryRepository } from "../../lib/factory-config.js";
import { githubFromEnv, type RepoRef } from "../../lib/github.js";
import { createCheckpointRunner } from "./checkpoints.js";
import {
	EXECUTION_HEARTBEAT_INTERVAL_MS,
	SPEC_TO_PR_MAX_RETRIES,
	SPEC_TO_PR_RETRY_BACKOFF,
	SPEC_TO_PR_RETRY_WAIT_MS,
	SPEC_TO_PR_TASK_NAME,
	SPEC_TO_PR_TASK_PLAN,
	SPEC_TO_PR_TIMEOUT_SECONDS,
	STAGES,
} from "./constants.js";
import {
	inputSchema,
	type IntakeCheckpoint,
	type PullCheckpoint,
	type ReviewDecision,
	type WorkflowResult,
} from "./contracts.js";
import { operationId, sandboxContext } from "./context.js";
import { completeDiff, ensureCommit, verifyPush } from "./git.js";
import {
	loadIntake,
	runAnalysis,
	runImplementation,
	runReview,
	runSelfReview,
} from "./model-stages.js";
import { getOrCreateSandbox, terminateCheckpointedSandbox } from "./sandbox.js";
import { finish, recordFailure } from "./terminal.js";

export { branchName } from "./context.js";

function formatReviewBody(review: ReviewDecision): string {
	const tier = review.riskTier ?? "unknown";
	const header = `## Internal review: ${review.decision === "approve" ? "approved" : "changes requested"}\n\n**Risk tier:** ${tier}\n\n${review.summary}`;
	const findings = review.topFindings;
	if (!findings || findings.length === 0) return header;
	const rows = findings.map(
		(f) =>
			`| ${f.severity} | ${f.confidence} | ${f.source} | \`${f.file}\` | ${f.description} |`,
	);
	return `${header}\n\n### Top findings\n\n| Severity | Confidence | Source | File | Description |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}`;
}

export const specToPr = task(
	{
		name: SPEC_TO_PR_TASK_NAME,
		plan: SPEC_TO_PR_TASK_PLAN,
		retry: {
			maxRetries: SPEC_TO_PR_MAX_RETRIES,
			waitDurationMs: SPEC_TO_PR_RETRY_WAIT_MS,
			backoffScaling: SPEC_TO_PR_RETRY_BACKOFF,
		},
		timeoutSeconds: SPEC_TO_PR_TIMEOUT_SECONDS,
	},
	async function specToPr(rawInput: unknown): Promise<WorkflowResult> {
		const { issueNumber, runId } = inputSchema.parse(rawInput);
		const repository = factoryRepository();
		const repo: RepoRef = repository;
		const triggerLabel = factoryLabel();
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN is not set");
		const store = factoryStore();
		const subjectKey = `github:${repository.fullName.toLowerCase()}:issue:${issueNumber}`;
		await store.runs.ensureRun({
			id: runId,
			rootRunId: runId,
			kind: "workflow",
			name: SPEC_TO_PR_TASK_NAME,
			triggerType: "github.issues.labeled",
			input: { issueNumber },
		});
		const priorResult = await store.runs.getTerminal<WorkflowResult>(runId);
		if (priorResult.found) {
			if (priorResult.value === undefined) {
				throw new Error("Terminal factory run is missing its result");
			}
			await terminateCheckpointedSandbox(
				new RenderSandboxProvider(),
				store,
				runId,
			);
			return priorResult.value;
		}
		const gh = githubFromEnv();
		const executionId = randomUUID();
		const executionClaim = await store.runs.beginExecution(
			runId,
			executionId,
			30,
		);
		if (executionClaim.kind === "busy") {
			return { skipped: "attempt is already running" };
		}
		let execution: ExecutionHandle = executionClaim.execution;
		const acquiredSubjectLease = await store.leases.tryAcquire(
			subjectKey,
			runId,
			26 * 60 * 60,
		);
		if (!acquiredSubjectLease) {
			const result = { skipped: "issue is already running" } as const;
			await store.completeRun({
				runId,
				execution,
				status: "cancelled",
				errorCode: "subject_busy",
				result,
			});
			return result;
		}
		let subjectLease = acquiredSubjectLease;

		let heartbeatError: Error | undefined;
		const heartbeat = setInterval(() => {
			void Promise.all([
				store.runs
					.refreshExecution(execution, 30)
					.then((refreshed) => {
						execution = refreshed;
					}),
				store.leases
					.refresh(subjectLease, 26 * 60 * 60)
					.then((refreshed) => {
						subjectLease = refreshed;
					}),
			]).catch((error) => {
				heartbeatError =
					error instanceof Error ? error : new Error(String(error));
			});
		}, EXECUTION_HEARTBEAT_INTERVAL_MS);
		heartbeat.unref();
		const assertHeartbeat = () => {
			if (heartbeatError) throw heartbeatError;
		};
		const releaseExecutionLock = async () => {
			clearInterval(heartbeat);
			await store.runs.releaseExecution(execution).catch(() => {});
		};

		const checkpoints = createCheckpointRunner({
			runId,
			execution,
			store,
			refreshSubjectLease: () =>
				store.leases
					.refresh(subjectLease, 26 * 60 * 60)
					.then((refreshed) => {
						subjectLease = refreshed;
					}),
		});
		const parentRun = (stepKey: string, generation: number) => ({
			rootRunId: runId,
			runId,
			stepKey,
			generation,
		});
		let sandbox: Sandbox | undefined;
		let terminal = false;
		const finishTerminal = async (
			result: WorkflowResult,
		): Promise<WorkflowResult> => {
			const finished = await finish({
				store,
				runId,
				execution,
				result,
			});
			terminal = true;
			return finished;
		};

		try {
			const intake = await checkpoints.run<IntakeCheckpoint>(
				STAGES.intake,
				({ generation }) =>
					loadIntake({
						gh,
						repo,
						issueNumber,
						triggerLabel,
						run: parentRun(STAGES.intake.key, generation),
					}),
			);
			await gh.removeLabel(repo, issueNumber, triggerLabel);

			if (!intake.triage.hasEnoughDetail) {
				const questions = intake.triage.questions.length
					? intake.triage.questions
					: [
							"What concrete outcome and acceptance criteria should the factory implement?",
						];
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(runId, "clarification"),
					`The factory needs more detail before it can proceed:\n\n${questions
						.map((question, index) => `${index + 1}. ${question}`)
						.join(
							"\n",
						)}\n\nReply with the details, then reapply the \`${triggerLabel}\` label.`,
				);
				return finishTerminal({
					status: "needs_clarification",
					questions,
				});
			}

			const provider = new RenderSandboxProvider();
			const sandboxResult = await getOrCreateSandbox({
				provider,
				store,
				execution,
				token,
				repository,
				issueNumber,
				runId,
			});
			const activeSandbox = sandboxResult.sandbox;
			sandbox = activeSandbox;
			const sandboxState = sandboxResult.state;
			const context = sandboxContext();
			assertHeartbeat();

			const analysis = await checkpoints.run(STAGES.analysis, ({ generation }) =>
				runAnalysis({
					workItem: intake.workItem,
					sandboxId: activeSandbox.id,
					run: parentRun(STAGES.analysis.key, generation),
				}),
			);
			let implementation1 = await checkpoints.run(
				STAGES.implementation1,
				({ generation }) =>
					runImplementation({
						message: `${context}\n\nWork item:\n${intake.workItem}\n\nApproved analysis:\n${analysis}`,
						sandboxId: activeSandbox.id,
						run: parentRun(STAGES.implementation1.key, generation),
					}),
			);
			let commit1 = await checkpoints.run(STAGES.commit1, () =>
				ensureCommit({
					sandbox: activeSandbox,
					state: sandboxState,
					previousSha: sandboxState.baseSha,
					message: `Implement issue #${issueNumber}: ${intake.issue.title}`,
				}),
			);
			if (!commit1) {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(runId, "no-changes"),
					`The factory produced no repository changes. Reapply the \`${triggerLabel}\` label to retry.`,
				);
				return finishTerminal({ status: "no_changes" });
			}

			const diff1 = await completeDiff({
				sandbox: activeSandbox,
				state: sandboxState,
				headSha: commit1.sha,
			});

			const selfReviewResult = await checkpoints.run(
				STAGES.selfReview1,
				({ generation }) =>
					runSelfReview({
						diff: diff1,
						workItem: intake.workItem,
						run: parentRun(STAGES.selfReview1.key, generation),
					}),
			);
			if (selfReviewResult.needsRevision && selfReviewResult.issues.length > 0) {
				const previousSha = commit1.sha;
				const selfReviewFixes = await checkpoints.run(
					STAGES.selfReviewFix,
					({ generation }) =>
						runImplementation({
							message:
								`${context}\n\nFix the following self-review issues in the current implementation:\n${intake.workItem}\n\n` +
								`Original analysis:\n${analysis}\n\nSelf-review issues:\n${selfReviewResult.issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}\n\n` +
								`Do not restructure the implementation. Only fix the specific issues listed above.`,
							sandboxId: activeSandbox.id,
							run: parentRun(STAGES.selfReviewFix.key, generation),
						}),
				);
				const selfReviewCommit = await checkpoints.run(
					STAGES.selfReviewCommit,
					() =>
						ensureCommit({
							sandbox: activeSandbox,
							state: sandboxState,
							previousSha,
							message: `Self-review fixes for issue #${issueNumber}`,
						}),
				);
				if (selfReviewCommit) {
					implementation1 = selfReviewFixes;
					commit1 = selfReviewCommit;
				}
			}

			const reviewDiff = selfReviewResult.needsRevision
				? await completeDiff({
						sandbox: activeSandbox,
						state: sandboxState,
						headSha: commit1.sha,
					})
				: diff1;
			const review1 = await checkpoints.run(STAGES.review1, ({ generation }) =>
				runReview({
					diff: reviewDiff,
					implementation: implementation1,
					run: parentRun(STAGES.review1.key, generation),
				}),
			);

			let finalCommit = commit1;
			let finalImplementation = implementation1;
			let finalReview = review1;
			if (review1.decision === "request_changes") {
				finalImplementation = await checkpoints.run(
					STAGES.implementation2,
					({ generation }) =>
						runImplementation({
							message:
								`${context}\n\nRevise the existing implementation for this work item:\n${intake.workItem}\n\n` +
								`Original analysis:\n${analysis}\n\nBlocking internal review:\n${review1.summary}\n\n${review1.details}`,
							sandboxId: activeSandbox.id,
						run: parentRun(STAGES.implementation2.key, generation),
						}),
				);
				const commit2 = await checkpoints.run(STAGES.commit2, () =>
					ensureCommit({
						sandbox: activeSandbox,
						state: sandboxState,
						previousSha: commit1.sha,
						message: `Address internal review for issue #${issueNumber}`,
					}),
				);
				if (!commit2) {
					finalReview = {
						decision: "request_changes",
						summary: "The revision produced no changes.",
						details: review1.details,
					};
				} else {
					finalCommit = commit2;
					const diff2 = await completeDiff({
						sandbox: activeSandbox,
						state: sandboxState,
						headSha: commit2.sha,
					});
					finalReview = await checkpoints.run(STAGES.review2, ({ generation }) =>
						runReview({
							diff: diff2,
							implementation: finalImplementation,
							run: parentRun(STAGES.review2.key, generation),
						}),
					);
				}
			}

			if (finalReview.decision !== "approve") {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(runId, "changes-requested"),
					`The factory stopped after its revision still needed changes:\n\n${finalReview.summary}\n\n` +
						`Reapply the \`${triggerLabel}\` label after updating the issue or repository.`,
				);
				return finishTerminal({
					status: "changes_requested",
					summary: finalReview.summary,
				});
			}

			assertHeartbeat();
			await checkpoints.run(STAGES.push, () =>
				verifyPush({
					sandbox: activeSandbox,
					token,
					state: sandboxState,
					expectedSha: finalCommit.sha,
				}),
			);
			const pull = await checkpoints.run<PullCheckpoint>(
				STAGES.pullRequest,
				async () => {
					const result = await gh.ensurePull(repo, {
						title: `Fix #${issueNumber}: ${intake.issue.title}`,
						head: sandboxState.branch,
						base: sandboxState.base,
						draft: true,
						expectedHeadSha: finalCommit.sha,
						body:
							`Automated implementation for #${issueNumber}.\n\n` +
							`${formatReviewBody(finalReview)}\n\n` +
							`## Implementation report\n\n${finalImplementation.raw}\n\nCloses #${issueNumber}.`,
					});
					return {
						number: result.number,
						htmlUrl: result.htmlUrl,
						headSha: result.headSha,
					};
				},
			);
			await Promise.all([
				store.runs.addLink({
					runId,
					kind: "git.branch",
					externalId: sandboxState.branch,
					metadata: { headSha: finalCommit.sha },
				}),
				store.runs.addLink({
					runId,
					kind: "github.pull",
					externalId: `${repository.fullName}#${pull.number}`,
					url: pull.htmlUrl,
					metadata: { headSha: pull.headSha },
				}),
			]);
			await gh.ensureIssueComment(
				repo,
				issueNumber,
				operationId(runId, "draft-pr"),
				`The factory opened a reviewed draft pull request: ${pull.htmlUrl}`,
			);

			return finishTerminal({
				status: "draft_pr_opened",
				decision: "approve",
				pullRequest: pull.htmlUrl,
			});
		} catch (error) {
			terminal = await recordFailure({
				store,
				execution,
				gh,
				repo,
				issueNumber,
				runId,
				triggerLabel,
			}).catch(() => false);
			throw error;
		} finally {
			await releaseExecutionLock();
			if (terminal) await sandbox?.terminate().catch(() => {});
		}
	},
);
