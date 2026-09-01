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
import {
	createCheckpointRunner,
	type CheckpointRunner,
} from "./checkpoints.js";
import { factoryConfig } from "../../../factory.config.js";
import {
	EXECUTION_CLAIM_TTL_SECONDS,
	EXECUTION_HEARTBEAT_INTERVAL_MS,
	MAX_VERIFY_ITERATIONS,
	OPERATIONS,
	SPEC_TO_PR_MAX_RETRIES,
	SPEC_TO_PR_RETRY_BACKOFF,
	SPEC_TO_PR_RETRY_WAIT_MS,
	SPEC_TO_PR_TASK_NAME,
	SPEC_TO_PR_TASK_PLAN,
	SPEC_TO_PR_TIMEOUT_SECONDS,
	STAGES,
	SUBJECT_LEASE_TTL_SECONDS,
} from "./constants.js";
import {
	inputSchema,
	type CommitCheckpoint,
	type ImplementationCheckpoint,
	type IntakeCheckpoint,
	type PullCheckpoint,
	type ReadySandboxCheckpoint,
	type ReviewDecision,
	type WorkflowResult,
} from "./contracts.js";
import { operationId, sandboxContext } from "./context.js";
import {
	completeDiff,
	ensureCommit,
	formatVerificationFailures,
	runVerification,
	verifyPush,
} from "./git.js";
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

// ---------------------------------------------------------------------------
// Shared phase context passed to extracted helpers
// ---------------------------------------------------------------------------

interface PhaseContext {
	sandbox: Sandbox;
	sandboxState: ReadySandboxCheckpoint;
	checkpoints: CheckpointRunner;
	parentRun: (
		stepKey: string,
		generation: number,
	) => {
		rootRunId: string;
		runId: string;
		stepKey: string;
		generation: number;
	};
}

// ---------------------------------------------------------------------------
// Phase: verify implementation against configured commands
// ---------------------------------------------------------------------------

type VerifyOutcome =
	| {
			passed: true;
			implementation: ImplementationCheckpoint;
			commit: CommitCheckpoint;
	  }
	| { passed: false; failures: string };

async function verifyImplementation(
	ctx: PhaseContext,
	implementation: ImplementationCheckpoint,
	commit: CommitCheckpoint,
	workItem: string,
	issueNumber: number,
): Promise<VerifyOutcome> {
	const commands = factoryConfig.verify;
	if (commands.length === 0) {
		return { passed: true, implementation, commit };
	}

	const context = sandboxContext();
	let currentImpl = implementation;
	let currentCommit = commit;

	let result = await ctx.checkpoints.run(STAGES.verify1, () =>
		runVerification(ctx.sandbox, commands),
	);

	for (
		let round = 0;
		!result.passed && round < MAX_VERIFY_ITERATIONS;
		round++
	) {
		const failures = formatVerificationFailures(result);
		const previousSha = currentCommit.sha;

		currentImpl = await ctx.checkpoints.run(
			STAGES.verifyFix,
			({ generation }) =>
				runImplementation({
					message:
						`${context}\n\nThe following verification commands failed after your implementation.\n` +
						`Fix the issues so all commands pass.\n\nWork item:\n${workItem}\n\n` +
						`Failures:\n${failures}`,
					sandboxId: ctx.sandbox.id,
					run: ctx.parentRun(STAGES.verifyFix.key, generation),
				}),
		);

		const fixCommit = await ctx.checkpoints.run(
			STAGES.verifyFixCommit,
			() =>
				ensureCommit({
					sandbox: ctx.sandbox,
					state: ctx.sandboxState,
					previousSha,
					message: `Fix verification failures for issue #${issueNumber}`,
				}),
		);
		if (fixCommit) currentCommit = fixCommit;

		await ctx.checkpoints.invalidateDownstream(STAGES.verify1);
		result = await ctx.checkpoints.run(STAGES.verify1, () =>
			runVerification(ctx.sandbox, commands),
		);
		if (!result.passed) {
			await ctx.checkpoints.invalidateDownstream(STAGES.verifyFix);
		}
	}

	if (!result.passed) {
		return { passed: false, failures: formatVerificationFailures(result) };
	}
	return { passed: true, implementation: currentImpl, commit: currentCommit };
}

// ---------------------------------------------------------------------------
// Phase: lightweight self-review for obvious issues
// ---------------------------------------------------------------------------

async function applySelfReview(
	ctx: PhaseContext,
	implementation: ImplementationCheckpoint,
	commit: CommitCheckpoint,
	intake: IntakeCheckpoint,
	analysis: string,
	issueNumber: number,
): Promise<{
	implementation: ImplementationCheckpoint;
	commit: CommitCheckpoint;
}> {
	const diff = await completeDiff({
		sandbox: ctx.sandbox,
		state: ctx.sandboxState,
		headSha: commit.sha,
	});

	const result = await ctx.checkpoints.run(
		STAGES.selfReview1,
		({ generation }) =>
			runSelfReview({
				diff,
				workItem: intake.workItem,
				run: ctx.parentRun(STAGES.selfReview1.key, generation),
			}),
	);

	if (!result.needsRevision || result.issues.length === 0) {
		return { implementation, commit };
	}

	const context = sandboxContext();
	const previousSha = commit.sha;
	const fixedImpl = await ctx.checkpoints.run(
		STAGES.selfReviewFix,
		({ generation }) =>
			runImplementation({
				message:
					`${context}\n\nFix the following self-review issues in the current implementation:\n${intake.workItem}\n\n` +
					`Original analysis:\n${analysis}\n\nSelf-review issues:\n${result.issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}\n\n` +
					`Do not restructure the implementation. Only fix the specific issues listed above.`,
				sandboxId: ctx.sandbox.id,
				run: ctx.parentRun(STAGES.selfReviewFix.key, generation),
			}),
	);

	const fixedCommit = await ctx.checkpoints.run(
		STAGES.selfReviewCommit,
		() =>
			ensureCommit({
				sandbox: ctx.sandbox,
				state: ctx.sandboxState,
				previousSha,
				message: `Self-review fixes for issue #${issueNumber}`,
			}),
	);

	return fixedCommit
		? { implementation: fixedImpl, commit: fixedCommit }
		: { implementation, commit };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main orchestration task
// ---------------------------------------------------------------------------

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
			EXECUTION_CLAIM_TTL_SECONDS,
		);
		if (executionClaim.kind === "busy") {
			return { skipped: "attempt is already running" };
		}
		let execution: ExecutionHandle = executionClaim.execution;
		const acquiredSubjectLease = await store.leases.tryAcquire(
			subjectKey,
			runId,
			SUBJECT_LEASE_TTL_SECONDS,
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
					.refreshExecution(execution, EXECUTION_CLAIM_TTL_SECONDS)
					.then((refreshed) => {
						execution = refreshed;
					}),
				store.leases
					.refresh(subjectLease, SUBJECT_LEASE_TTL_SECONDS)
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
					.refresh(subjectLease, SUBJECT_LEASE_TTL_SECONDS)
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
			// ── Intake ──────────────────────────────────────────────────
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
					operationId(runId, OPERATIONS.clarification),
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

			// ── Sandbox ─────────────────────────────────────────────────
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
			assertHeartbeat();

			const ctx: PhaseContext = {
				sandbox: activeSandbox,
				sandboxState,
				checkpoints,
				parentRun,
			};
			const context = sandboxContext();

			// ── Analysis ────────────────────────────────────────────────
			const analysis = await checkpoints.run(
				STAGES.analysis,
				({ generation }) =>
					runAnalysis({
						workItem: intake.workItem,
						sandboxId: activeSandbox.id,
						run: parentRun(STAGES.analysis.key, generation),
					}),
			);

			// ── Initial implementation ──────────────────────────────────
			let implementation = await checkpoints.run(
				STAGES.implementation1,
				({ generation }) =>
					runImplementation({
						message: `${context}\n\nWork item:\n${intake.workItem}\n\nApproved analysis:\n${analysis}`,
						sandboxId: activeSandbox.id,
						run: parentRun(STAGES.implementation1.key, generation),
					}),
			);
			let commit = await checkpoints.run(STAGES.commit1, () =>
				ensureCommit({
					sandbox: activeSandbox,
					state: sandboxState,
					previousSha: sandboxState.baseSha,
					message: `Implement issue #${issueNumber}: ${intake.issue.title}`,
				}),
			);
			if (!commit) {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(runId, OPERATIONS.noChanges),
					`The factory produced no repository changes. Reapply the \`${triggerLabel}\` label to retry.`,
				);
				return finishTerminal({ status: "no_changes" });
			}

			// ── Verification ────────────────────────────────────────────
			const verified = await verifyImplementation(
				ctx,
				implementation,
				commit,
				intake.workItem,
				issueNumber,
			);
			if (!verified.passed) {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(runId, OPERATIONS.verifyFailed),
					`The factory could not pass verification after ${MAX_VERIFY_ITERATIONS} fix rounds:\n\n\`\`\`\n${verified.failures.slice(0, 3000)}\n\`\`\`\n\nReapply the \`${triggerLabel}\` label to retry.`,
				);
				return finishTerminal({
					status: "changes_requested",
					summary: `Verification failed: ${verified.failures.slice(0, 500)}`,
				});
			}
			implementation = verified.implementation;
			commit = verified.commit;

			// ── Self-review ─────────────────────────────────────────────
			({ implementation, commit } = await applySelfReview(
				ctx,
				implementation,
				commit,
				intake,
				analysis,
				issueNumber,
			));

			// ── Review ──────────────────────────────────────────────────
			let reviewDiff = await completeDiff({
				sandbox: activeSandbox,
				state: sandboxState,
				headSha: commit.sha,
			});
			let review = await checkpoints.run(
				STAGES.review1,
				({ generation }) =>
					runReview({
						diff: reviewDiff,
						implementation,
						run: parentRun(STAGES.review1.key, generation),
					}),
			);

			// ── Revision (if review requests changes) ───────────────────
			if (review.decision === "request_changes") {
				const priorSha = commit.sha;
				implementation = await checkpoints.run(
					STAGES.implementation2,
					({ generation }) =>
						runImplementation({
							message:
								`${context}\n\nRevise the existing implementation for this work item:\n${intake.workItem}\n\n` +
								`Original analysis:\n${analysis}\n\nBlocking internal review:\n${review.summary}\n\n${review.details}`,
							sandboxId: activeSandbox.id,
							run: parentRun(STAGES.implementation2.key, generation),
						}),
				);
				const revisionCommit = await checkpoints.run(STAGES.commit2, () =>
					ensureCommit({
						sandbox: activeSandbox,
						state: sandboxState,
						previousSha: priorSha,
						message: `Address internal review for issue #${issueNumber}`,
					}),
				);
				if (revisionCommit) {
					commit = revisionCommit;
					reviewDiff = await completeDiff({
						sandbox: activeSandbox,
						state: sandboxState,
						headSha: commit.sha,
					});
					review = await checkpoints.run(
						STAGES.review2,
						({ generation }) =>
							runReview({
								diff: reviewDiff,
								implementation,
								run: parentRun(STAGES.review2.key, generation),
							}),
					);
				} else {
					review = {
						...review,
						summary: "The revision produced no changes.",
					};
				}
			}

			if (review.decision !== "approve") {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(runId, OPERATIONS.changesRequested),
					`The factory stopped after its revision still needed changes:\n\n${review.summary}\n\n` +
						`Reapply the \`${triggerLabel}\` label after updating the issue or repository.`,
				);
				return finishTerminal({
					status: "changes_requested",
					summary: review.summary,
				});
			}

			// ── Push and open PR ────────────────────────────────────────
			assertHeartbeat();
			await checkpoints.run(STAGES.push, () =>
				verifyPush({
					sandbox: activeSandbox,
					token,
					state: sandboxState,
					expectedSha: commit.sha,
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
						expectedHeadSha: commit.sha,
						body:
							`Automated implementation for #${issueNumber}.\n\n` +
							`${formatReviewBody(review)}\n\n` +
							`## Implementation report\n\n${implementation.raw}\n\nCloses #${issueNumber}.`,
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
					metadata: { headSha: commit.sha },
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
				operationId(runId, OPERATIONS.draftPr),
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
