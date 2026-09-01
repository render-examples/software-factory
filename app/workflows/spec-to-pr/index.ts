/** One-repository factory: labeled issue → analysis → implementation → review → draft PR. */
import {
	RenderSandboxProvider,
	shellEscape,
	workflow,
	type Sandbox,
	type WorkflowContext,
} from "#factory/sdk";
import { factoryStore } from "#factory/store";
import { factoryLabel, factoryRepository } from "../../lib/factory-config.js";
import { githubFromEnv, type RepoRef } from "../../lib/github.js";
import { execGitWithToken, githubRemoteUrl } from "../../lib/sandbox-git.js";
import { factoryConfig } from "../../../factory.config.js";
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
import { branchName, operationId, sandboxContext } from "./context.js";
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

const REPO_DIR = "/home/user/repo";
const MAX_VERIFY_ITERATIONS = 3;

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
		const context = sandboxContext();
		const subjectKey = `github:${repository.fullName.toLowerCase()}:issue:${issueNumber}`;
		const subjectLease = await store.leases.tryAcquire(subjectKey, runId, 26 * 60 * 60);
		if (!subjectLease) {
			return { skipped: "issue is already running" } as WorkflowResult;
		}

		// ── Intake ──────────────────────────────────────────────────────
		const intake = await ctx.step<IntakeCheckpoint>("intake", () =>
			loadIntake({
				gh,
				repo,
				issueNumber,
				triggerLabel,
				run: ctx.runContext("intake"),
			}),
		);
		await ctx.step("remove-label", () =>
			gh.removeLabel(repo, issueNumber, triggerLabel),
		);

		if (!intake.triage.hasEnoughDetail) {
			const questions = intake.triage.questions.length
				? intake.triage.questions
				: ["What concrete outcome and acceptance criteria should the factory implement?"];
			await gh.ensureIssueComment(
				repo,
				issueNumber,
				operationId(runId, "clarification"),
				`The factory needs more detail before it can proceed:\n\n${questions
					.map((q, i) => `${i + 1}. ${q}`)
					.join("\n")}\n\nReply with the details, then reapply the \`${triggerLabel}\` label.`,
			);
			return { status: "needs_clarification", questions };
		}

		// ── Sandbox ─────────────────────────────────────────────────────
		const sandboxState = await ctx.step<ReadySandboxCheckpoint>(
			"sandbox",
			async () => {
				const result = await setupSandbox(token, repository, issueNumber, runId);
				return result.state;
			},
		);
		const provider = new RenderSandboxProvider();
		const sandbox = await provider.connect(sandboxState.id);

		try {
			// ── Analysis ────────────────────────────────────────────────
			const analysis = await ctx.step("analysis", () =>
				runAnalysis({
					workItem: intake.workItem,
					sandboxId: sandbox.id,
					run: ctx.runContext("analysis"),
				}),
			);

			// ── Implementation ──────────────────────────────────────────
			let implementation = await ctx.step<ImplementationCheckpoint>(
				"implementation",
				() =>
					runImplementation({
						message: `${context}\n\nWork item:\n${intake.workItem}\n\nApproved analysis:\n${analysis}`,
						sandboxId: sandbox.id,
						run: ctx.runContext("implementation"),
					}),
			);
			const maybeCommit = await ctx.step<CommitCheckpoint | null>("commit", () =>
				ensureCommit({
					sandbox,
					state: sandboxState,
					previousSha: sandboxState.baseSha,
					message: `Implement issue #${issueNumber}: ${intake.issue.title}`,
				}),
			);
			if (!maybeCommit) {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(runId, "no-changes"),
					`The factory produced no repository changes. Reapply the \`${triggerLabel}\` label to retry.`,
				);
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
							repo,
							issueNumber,
							operationId(runId, "verify-failed"),
							`The factory could not pass verification after ${MAX_VERIFY_ITERATIONS} fix rounds:\n\n\`\`\`\n${failures.slice(0, 3000)}\n\`\`\`\n\nReapply the \`${triggerLabel}\` label to retry.`,
						);
						return {
							status: "changes_requested",
							summary: `Verification failed: ${failures.slice(0, 500)}`,
						};
					}
					const failures = formatVerificationFailures(result);
					const prevSha = commit.sha;
					implementation = await ctx.step(`verify-fix-${round}`, () =>
						runImplementation({
							message:
								`${context}\n\nThe following verification commands failed.\n` +
								`Fix the issues so all commands pass.\n\nWork item:\n${intake.workItem}\n\nFailures:\n${failures}`,
							sandboxId: sandbox.id,
							run: ctx.runContext(`verify-fix-${round}`),
						}),
					);
					const fixCommit = await ctx.step<CommitCheckpoint | null>(
						`verify-fix-commit-${round}`,
						() =>
							ensureCommit({
								sandbox,
								state: sandboxState,
								previousSha: prevSha,
								message: `Fix verification failures for issue #${issueNumber}`,
							}),
					);
					if (fixCommit) commit = fixCommit;
				}
			}

			// ── Self-review ─────────────────────────────────────────────
			const selfReviewDiff = await completeDiff({
				sandbox,
				state: sandboxState,
				headSha: commit.sha,
			});
			const selfReview = await ctx.step("self-review", () =>
				runSelfReview({
					diff: selfReviewDiff,
					workItem: intake.workItem,
					run: ctx.runContext("self-review"),
				}),
			);
			if (selfReview.needsRevision && selfReview.issues.length > 0) {
				const previousSha = commit.sha;
				implementation = await ctx.step("self-review-fix", () =>
					runImplementation({
						message:
							`${context}\n\nFix the following self-review issues:\n${intake.workItem}\n\n` +
							`Original analysis:\n${analysis}\n\nSelf-review issues:\n${selfReview.issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}\n\n` +
							`Do not restructure the implementation. Only fix the specific issues listed above.`,
						sandboxId: sandbox.id,
						run: ctx.runContext("self-review-fix"),
					}),
				);
				const fixCommit = await ctx.step("self-review-commit", () =>
					ensureCommit({
						sandbox,
						state: sandboxState,
						previousSha,
						message: `Self-review fixes for issue #${issueNumber}`,
					}),
				);
				if (fixCommit) commit = fixCommit;
			}

			// ── Review ──────────────────────────────────────────────────
			let reviewDiff = await completeDiff({
				sandbox,
				state: sandboxState,
				headSha: commit.sha,
			});
			let review = await ctx.step<ReviewDecision>("review", () =>
				runReview({
					diff: reviewDiff,
					implementation,
					run: ctx.runContext("review"),
				}),
			);

			// ── Revision (one round if review requests changes) ─────────
			if (review.decision === "request_changes") {
				const priorSha = commit.sha;
				implementation = await ctx.step("revision", () =>
					runImplementation({
						message:
							`${context}\n\nRevise the existing implementation for this work item:\n${intake.workItem}\n\n` +
							`Original analysis:\n${analysis}\n\nBlocking internal review:\n${review.summary}\n\n${review.details}`,
						sandboxId: sandbox.id,
						run: ctx.runContext("revision"),
					}),
				);
				const revisionCommit = await ctx.step("revision-commit", () =>
					ensureCommit({
						sandbox,
						state: sandboxState,
						previousSha: priorSha,
						message: `Address internal review for issue #${issueNumber}`,
					}),
				);
				if (revisionCommit) {
					commit = revisionCommit;
					reviewDiff = await completeDiff({
						sandbox,
						state: sandboxState,
						headSha: commit.sha,
					});
					review = await ctx.step("re-review", () =>
						runReview({
							diff: reviewDiff,
							implementation,
							run: ctx.runContext("re-review"),
						}),
					);
				} else {
					review = { ...review, summary: "The revision produced no changes." };
				}
			}

			if (review.decision !== "approve") {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(runId, "changes-requested"),
					`The factory stopped after its revision still needed changes:\n\n${review.summary}\n\n` +
						`Reapply the \`${triggerLabel}\` label after updating the issue or repository.`,
				);
				return { status: "changes_requested", summary: review.summary };
			}

			// ── Push and open PR ────────────────────────────────────────
			const finalSha = commit.sha;
			await ctx.step("push", () =>
				verifyPush({
					sandbox,
					token,
					state: sandboxState,
					expectedSha: finalSha,
				}),
			);
			const pull = await ctx.step<PullCheckpoint>("pull-request", async () => {
				const result = await gh.ensurePull(repo, {
					title: `Fix #${issueNumber}: ${intake.issue.title}`,
					head: sandboxState.branch,
					base: sandboxState.base,
					draft: true,
					expectedHeadSha: finalSha,
					body:
						`Automated implementation for #${issueNumber}.\n\n` +
						`${formatReviewBody(review)}\n\n` +
						`## Implementation report\n\n${implementation.raw}\n\nCloses #${issueNumber}.`,
				});
				return { number: result.number, htmlUrl: result.htmlUrl, headSha: result.headSha };
			});
			await Promise.all([
				store.runs.addLink({
					runId,
					kind: "git.branch",
					externalId: sandboxState.branch,
					metadata: { headSha: finalSha },
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

			return {
				status: "draft_pr_opened",
				decision: "approve",
				pullRequest: pull.htmlUrl,
			};
		} finally {
			await sandbox.terminate().catch(() => {});
		}
	},
);
