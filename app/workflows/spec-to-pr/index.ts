/** One-repository factory: labeled issue → analysis → implementation → review → draft PR. */
import {
	RenderSandboxProvider,
	shellEscape,
	workflow,
	type Sandbox,
	type SerializedEnvironment,
	type WorkflowContext,
} from "#factory/sdk";
import { factoryStore } from "#factory/store";
import { factoryLabel, factoryRepository } from "../../lib/factory-config.js";
import { githubFromEnv, type RepoRef } from "../../lib/github.js";
import { execGitWithToken, githubRemoteUrl } from "../../lib/sandbox-git.js";
import { factoryConfig } from "../../../factory.config.js";
import { MAX_VERIFY_ITERATIONS, REPO_DIR } from "./constants.js";
import {
	type CommitCheckpoint,
	type ImplementationCheckpoint,
	inputSchema,
	type IntakeCheckpoint,
	type PullCheckpoint,
	type ReadySandboxCheckpoint,
	type ReviewDecision,
	type WorkflowResult,
} from "./contracts.js";
import { branchName, operationId } from "./context.js";
import {
	changesRequestedComment,
	clarificationComment,
	draftPrComment,
	noChangesComment,
	prBody,
	verifyFailedComment,
} from "./formatting.js";
import {
	completeDiff,
	ensureCommit,
	formatVerificationFailures,
	runCommand,
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

export { branchName } from "./context.js";

// ---------------------------------------------------------------------------
// Sandbox setup
// ---------------------------------------------------------------------------

async function setupSandbox(
	token: string,
	repository: ReturnType<typeof factoryRepository>,
	issueNumber: number,
	runId: string,
): Promise<{ sandbox: Sandbox; state: ReadySandboxCheckpoint }> {
	const provider = new RenderSandboxProvider();
	const sandbox = await provider.create({
		timeoutSeconds: 24 * 60 * 60,
		metadata: {
			workflow: "spec-to-pr",
			repo: repository.fullName,
			issue: String(issueNumber),
			run: runId,
		},
	});

	const remoteUrl = githubRemoteUrl(repository.owner, repository.repo);
	const clone = await execGitWithToken(sandbox, token, [
		"git", "clone", "--depth=50", remoteUrl, REPO_DIR,
	]);
	if (clone.exitCode !== 0) {
		throw new Error(`Clone failed: ${clone.output.slice(0, 500)}`);
	}

	const remoteHead = (
		await runCommand(
			sandbox,
			`git -C ${shellEscape(REPO_DIR)} symbolic-ref --short refs/remotes/origin/HEAD`,
			"Default branch discovery",
		)
	).trim();
	if (!remoteHead.startsWith("origin/")) {
		throw new Error(`Unexpected default branch ref: ${remoteHead}`);
	}
	const base = remoteHead.slice("origin/".length);
	const baseSha = (
		await runCommand(
			sandbox,
			`git -C ${shellEscape(REPO_DIR)} rev-parse ${shellEscape(remoteHead)}`,
			"Base revision",
		)
	).trim();
	const branch = branchName(issueNumber, runId);

	await runCommand(
		sandbox,
		`git -C ${shellEscape(REPO_DIR)} checkout -b ${shellEscape(branch)} ${shellEscape(remoteHead)} && ` +
			`git -C ${shellEscape(REPO_DIR)} config user.name "render-factory[bot]" && ` +
			`git -C ${shellEscape(REPO_DIR)} config user.email "bot@render-factory.dev"`,
		"Repository setup",
	);

	return {
		sandbox,
		state: { id: sandbox.id, ready: true, remoteUrl, remoteHead, base, baseSha, branch },
	};
}

// ---------------------------------------------------------------------------
// Main workflow
// ---------------------------------------------------------------------------

export const specToPr = workflow(
	{
		name: "spec-to-pr",
		plan: "standard",
		timeoutSeconds: 24 * 60 * 60,
		retry: { maxRetries: 2, waitDurationMs: 45_000, backoffScaling: 2 },
	},
	async function specToPr(
		ctx: WorkflowContext,
		rawInput: unknown,
	): Promise<WorkflowResult> {
		const { issueNumber, runId } = inputSchema.parse(rawInput);
		const repository = factoryRepository();
		const repo: RepoRef = repository;
		const triggerLabel = factoryLabel();
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN is not set");
		const gh = githubFromEnv();
		const store = factoryStore();

		const subjectLease = await store.leases.tryAcquire(
			`github:${repository.fullName.toLowerCase()}:issue:${issueNumber}`,
			runId,
			26 * 60 * 60,
		);
		if (!subjectLease) {
			return { status: "skipped", reason: "issue is already running" };
		}

		// ── Intake ──────────────────────────────────────────────────────

		const intake = await ctx.step<IntakeCheckpoint>("intake", () =>
			loadIntake({ gh, repo, issueNumber, triggerLabel, run: ctx.runContext("intake") }),
		);
		await ctx.step("remove-label", () =>
			gh.removeLabel(repo, issueNumber, triggerLabel),
		);

		if (!intake.triage.hasEnoughDetail) {
			const questions = intake.triage.questions.length
				? intake.triage.questions
				: ["What concrete outcome and acceptance criteria should the factory implement?"];
			await gh.ensureIssueComment(
				repo, issueNumber,
				operationId(runId, "clarification"),
				clarificationComment(questions, triggerLabel),
			);
			return { status: "needs_clarification", questions };
		}

		// ── Sandbox ─────────────────────────────────────────────────────

		const sandboxState = await ctx.step<ReadySandboxCheckpoint>("sandbox", async () => {
			const result = await setupSandbox(token, repository, issueNumber, runId);
			return result.state;
		});
		const sandbox = await new RenderSandboxProvider().connect(sandboxState.id);
		const environment: SerializedEnvironment = {
			sandbox: { id: sandboxState.id },
			workspace: {
				repoDir: REPO_DIR,
				repo: repository.fullName,
				branch: sandboxState.branch,
				baseSha: sandboxState.baseSha,
			},
		};

		try {
			// ── Analysis ────────────────────────────────────────────────
			const analysis = await ctx.step("analysis", () =>
				runAnalysis({ workItem: intake.workItem, environment, run: ctx.runContext("analysis") }),
			);

			// ── Implementation ──────────────────────────────────────────
			let implementation = await ctx.step<ImplementationCheckpoint>("implementation", () =>
				runImplementation({
					message: `Work item:\n${intake.workItem}\n\nApproved analysis:\n${analysis}`,
					environment,
					run: ctx.runContext("implementation"),
				}),
			);
			const maybeCommit = await ctx.step<CommitCheckpoint | null>("commit", () =>
				ensureCommit({
					sandbox, state: sandboxState, previousSha: sandboxState.baseSha,
					message: `Implement issue #${issueNumber}: ${intake.issue.title}`,
				}),
			);
			if (!maybeCommit) {
				await gh.ensureIssueComment(repo, issueNumber, operationId(runId, "no-changes"), noChangesComment(triggerLabel));
				return { status: "no_changes" };
			}
			let commit: CommitCheckpoint = maybeCommit;

			// ── Verification ────────────────────────────────────────────
			if (factoryConfig.verify.length > 0) {
				for (let round = 0; round <= MAX_VERIFY_ITERATIONS; round++) {
					const result = await ctx.step(`verify-${round}`, () =>
						runVerification(sandbox, factoryConfig.verify),
					);
					if (result.passed) break;
					if (round === MAX_VERIFY_ITERATIONS) {
						const failures = formatVerificationFailures(result);
						await gh.ensureIssueComment(
							repo, issueNumber, operationId(runId, "verify-failed"),
							verifyFailedComment(failures, MAX_VERIFY_ITERATIONS, triggerLabel),
						);
						return { status: "changes_requested", summary: `Verification failed: ${failures.slice(0, 500)}` };
					}
					const failures = formatVerificationFailures(result);
					const prevSha = commit.sha;
					implementation = await ctx.step(`verify-fix-${round}`, () =>
						runImplementation({
							message: `The following verification commands failed.\nFix the issues so all commands pass.\n\nWork item:\n${intake.workItem}\n\nFailures:\n${failures}`,
							environment,
							run: ctx.runContext(`verify-fix-${round}`),
						}),
					);
					const fixCommit = await ctx.step<CommitCheckpoint | null>(`verify-fix-commit-${round}`, () =>
						ensureCommit({
							sandbox, state: sandboxState, previousSha: prevSha,
							message: `Fix verification failures for issue #${issueNumber}`,
						}),
					);
					if (fixCommit) commit = fixCommit;
				}
			}

			// ── Self-review ─────────────────────────────────────────────
			const selfReviewDiff = await completeDiff({ sandbox, state: sandboxState, headSha: commit.sha });
			const selfReview = await ctx.step("self-review", () =>
				runSelfReview({ diff: selfReviewDiff, workItem: intake.workItem, run: ctx.runContext("self-review") }),
			);
			if (selfReview.needsRevision && selfReview.issues.length > 0) {
				const previousSha = commit.sha;
				implementation = await ctx.step("self-review-fix", () =>
					runImplementation({
						message: `Fix the following self-review issues:\n${intake.workItem}\n\nOriginal analysis:\n${analysis}\n\nSelf-review issues:\n${selfReview.issues.map((issue, i) => `${i + 1}. ${issue}`).join("\n")}\n\nDo not restructure the implementation. Only fix the specific issues listed above.`,
						environment,
						run: ctx.runContext("self-review-fix"),
					}),
				);
				const fixCommit = await ctx.step("self-review-commit", () =>
					ensureCommit({ sandbox, state: sandboxState, previousSha, message: `Self-review fixes for issue #${issueNumber}` }),
				);
				if (fixCommit) commit = fixCommit;
			}

			// ── Review ──────────────────────────────────────────────────
			let reviewDiff = await completeDiff({ sandbox, state: sandboxState, headSha: commit.sha });
			let review = await ctx.step<ReviewDecision>("review", () =>
				runReview({ diff: reviewDiff, implementation, run: ctx.runContext("review") }),
			);

			// ── Revision (one round if review requests changes) ─────────
			if (review.decision === "request_changes") {
				const priorSha = commit.sha;
				implementation = await ctx.step("revision", () =>
					runImplementation({
						message: `Revise the existing implementation for this work item:\n${intake.workItem}\n\nOriginal analysis:\n${analysis}\n\nBlocking internal review:\n${review.summary}\n\n${review.details}`,
						environment,
						run: ctx.runContext("revision"),
					}),
				);
				const revisionCommit = await ctx.step("revision-commit", () =>
					ensureCommit({ sandbox, state: sandboxState, previousSha: priorSha, message: `Address internal review for issue #${issueNumber}` }),
				);
				if (revisionCommit) {
					commit = revisionCommit;
					reviewDiff = await completeDiff({ sandbox, state: sandboxState, headSha: commit.sha });
					review = await ctx.step("re-review", () =>
						runReview({ diff: reviewDiff, implementation, run: ctx.runContext("re-review") }),
					);
				} else {
					review = { ...review, summary: "The revision produced no changes." };
				}
			}

			if (review.decision !== "approve") {
				await gh.ensureIssueComment(
					repo, issueNumber, operationId(runId, "changes-requested"),
					changesRequestedComment(review.summary, triggerLabel),
				);
				return { status: "changes_requested", summary: review.summary };
			}

			// ── Push and open PR ────────────────────────────────────────
			const finalSha = commit.sha;
			await ctx.step("push", () =>
				verifyPush({ sandbox, token, state: sandboxState, expectedSha: finalSha }),
			);
			const pull = await ctx.step<PullCheckpoint>("pull-request", async () => {
				const result = await gh.ensurePull(repo, {
					title: `Fix #${issueNumber}: ${intake.issue.title}`,
					head: sandboxState.branch,
					base: sandboxState.base,
					draft: true,
					expectedHeadSha: finalSha,
					body: prBody(issueNumber, review, implementation.raw),
				});
				return { number: result.number, htmlUrl: result.htmlUrl, headSha: result.headSha };
			});

			await Promise.all([
				store.runs.addLink({ runId, kind: "git.branch", externalId: sandboxState.branch, metadata: { headSha: finalSha } }),
				store.runs.addLink({ runId, kind: "github.pull", externalId: `${repository.fullName}#${pull.number}`, url: pull.htmlUrl, metadata: { headSha: pull.headSha } }),
			]);
			await gh.ensureIssueComment(repo, issueNumber, operationId(runId, "draft-pr"), draftPrComment(pull.htmlUrl));

			return { status: "draft_pr_opened", pullRequest: pull.htmlUrl };
		} finally {
			await sandbox.terminate().catch(() => {});
		}
	},
);
