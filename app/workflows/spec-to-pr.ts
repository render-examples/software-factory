/** One-repository factory: labeled issue → analysis → implementation → review → draft PR. */
import { createHash, randomUUID } from "node:crypto";
import { task } from "@renderinc/sdk/workflows";
import { z } from "zod";
import {
	collectExecOutput,
	isBlobRef,
	RenderSandboxProvider,
	requireBlob,
	shellEscape,
	type Sandbox,
	type SandboxProvider,
} from "#factory/sdk";
import {
	analysisTask,
	correctnessTask,
	implementTask,
	judgeTask,
	securityTask,
	testsTask,
	triageTask,
} from "../tasks/index.js";
import {
	githubFromEnv,
	type GitHub,
	type Issue,
	type IssueComment,
	type RepoRef,
} from "../lib/github.js";
import { factoryLabel, factoryRepository } from "../lib/factory-config.js";
import { execGitWithToken, githubRemoteUrl } from "../lib/sandbox-git.js";
import { parseModelJson } from "../lib/model-json.js";
import {
	claimExecution,
	clearCheckpoints,
	completeIntake,
	getCheckpoint,
	incrementFailureCount,
	putCheckpoint,
	refreshExecution,
	refreshIntakeLease,
	releaseExecution,
} from "../lib/run-store.js";

const inputSchema = z.object({
	issueNumber: z.number().int().positive(),
	attemptId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});
const triageSchema = z.object({
	hasEnoughDetail: z.boolean(),
	questions: z.array(z.string()),
	rationale: z.string(),
});
const implementationSchema = z.object({
	summary: z.string().min(1),
	verification: z
		.array(
			z.object({
				command: z.string().min(1),
				result: z.string(),
				passed: z.boolean(),
			}),
		)
		.min(1),
});
const decisionSchema = z.object({
	decision: z.enum(["approve", "request_changes"]),
	summary: z.string(),
});

type TriageResult = z.infer<typeof triageSchema>;
type ImplementationReport = z.infer<typeof implementationSchema>;
type ReviewDecision = z.infer<typeof decisionSchema> & { details: string };

interface IntakeCheckpoint {
	issue: Issue;
	workItem: string;
	triage: TriageResult;
}

interface PendingSandboxCheckpoint {
	id: string;
	ready: false;
}

interface ReadySandboxCheckpoint {
	id: string;
	ready: true;
	remoteUrl: string;
	remoteHead: string;
	base: string;
	baseSha: string;
	branch: string;
}

type SandboxCheckpoint = PendingSandboxCheckpoint | ReadySandboxCheckpoint;

interface ImplementationCheckpoint {
	raw: string;
	report: ImplementationReport;
}

interface CommitCheckpoint {
	sha: string;
}

interface PullCheckpoint {
	htmlUrl: string;
}

type WorkflowResult =
	| { skipped: string }
	| { status: "needs_clarification"; questions: string[] }
	| { status: "no_changes" }
	| { status: "changes_requested"; summary: string }
	| {
			status: "draft_pr_opened";
			decision: "approve";
			pullRequest: string;
	  };

const MAX_ISSUE_CHARS = 12_000;
const MAX_REVIEW_DIFF_CHARS = 200_000;
const REPO_DIR = "/home/user/repo";
const DOWNSTREAM_STAGES = [
	"analysis",
	"analysis-started",
	"implementation-1",
	"implementation-1-started",
	"commit-1",
	"review-1",
	"review-1-started",
	"implementation-2",
	"implementation-2-started",
	"commit-2",
	"review-2",
	"review-2-started",
	"push",
	"pull-request",
] as const;

function issueContext(issue: Issue, comments: IssueComment[]): string {
	const sections = [`# ${issue.title}`, "", issue.body || "(no description)"];
	if (comments.length > 0) {
		sections.push("", "## Comments");
		for (const comment of comments) {
			sections.push(`### @${comment.user}`, comment.body);
		}
	}
	return sections.join("\n").slice(0, MAX_ISSUE_CHARS);
}

function sandboxContext(): string {
	return `repoDir: ${REPO_DIR}`;
}

function operationId(attemptId: string, operation: string): string {
	return `${attemptId.slice(0, 64)}-${operation}`;
}

export function branchName(issueNumber: number, attemptId: string): string {
	const suffix = createHash("sha256")
		.update(attemptId)
		.digest("hex")
		.slice(0, 16);
	return `factory/issue-${issueNumber}-${suffix}`;
}

async function resolveTaskResult(result: string): Promise<string> {
	return isBlobRef(result) ? requireBlob(result) : result;
}

async function parseWithRepair<T>(
	schema: z.ZodType<T>,
	raw: string,
	stage: string,
	repair: () => Promise<string>,
): Promise<T> {
	const parsed = parseModelJson(schema, raw);
	if (parsed) return parsed;

	console.warn(
		JSON.stringify({
			event: "model_output_parse_failure",
			stage,
			attempt: 1,
		}),
	);
	const repairedRaw = await resolveTaskResult(await repair());
	const repaired = parseModelJson(schema, repairedRaw);
	if (repaired) return repaired;
	console.warn(
		JSON.stringify({
			event: "model_output_parse_failure",
			stage,
			attempt: 2,
		}),
	);
	throw new Error(`${stage} returned invalid structured output twice`);
}

async function checkpoint<T>(
	repository: string,
	issueNumber: number,
	attemptId: string,
	stage: string,
	execute: () => Promise<T>,
	replaySafe = true,
): Promise<T> {
	const existing = await getCheckpoint<T>(attemptId, stage);
	if (existing.found) {
		await refreshIntakeLease(repository, issueNumber, attemptId);
		return existing.value;
	}

	const startedStage = `${stage}-started`;
	if (!replaySafe) {
		const started = await getCheckpoint<boolean>(attemptId, startedStage);
		if (started.found) {
			throw new Error(
				`Stage "${stage}" was interrupted after execution began; refusing non-deterministic replay`,
			);
		}
		await putCheckpoint(attemptId, startedStage, true);
	}

	await refreshIntakeLease(repository, issueNumber, attemptId);
	let executionCompleted = false;
	try {
		const value = await execute();
		executionCompleted = true;
		await putCheckpoint(attemptId, stage, value);
		if (!replaySafe) {
			await clearCheckpoints(attemptId, [startedStage]);
		}
		return value;
	} catch (error) {
		// A normal thrown failure is safe to retry. A process crash never reaches
		// this catch, leaving the marker so model work is not repeated blindly.
		if (!executionCompleted && !replaySafe) {
			await clearCheckpoints(attemptId, [startedStage]).catch(() => {});
		}
		throw error;
	}
}

async function runCommand(
	sandbox: Sandbox,
	command: string,
	label: string,
): Promise<string> {
	const events = await sandbox.exec(command);
	const { output, exitCode } = await collectExecOutput(events);
	if (exitCode !== 0) {
		throw new Error(
			`${label} failed (exit ${exitCode}): ${output.slice(0, 500)}`,
		);
	}
	return output;
}

async function loadIntake(
	gh: GitHub,
	repo: RepoRef,
	issueNumber: number,
	triggerLabel: string,
): Promise<IntakeCheckpoint> {
	const issue = await gh.getIssue(repo, issueNumber);
	if (!issue.labels.includes(triggerLabel)) {
		throw new Error(`Issue no longer has the "${triggerLabel}" label`);
	}
	const comments = await gh.listIssueComments(repo, issueNumber);
	const workItem = issueContext(issue, comments);
	const triageRaw = await resolveTaskResult(
		await triageTask({ message: workItem }),
	);
	return {
		issue,
		workItem,
		triage: await parseWithRepair(
			triageSchema,
			triageRaw,
			"triage",
			async () =>
				await triageTask({
					message: `${workItem}\n\nYour previous response was not valid JSON. Return only the required JSON object.`,
				}),
		),
	};
}

async function connectCheckpointedSandbox(
	provider: SandboxProvider,
	saved: ReadySandboxCheckpoint,
): Promise<Sandbox | null> {
	try {
		const sandbox = await provider.connect(saved.id);
		if ((await sandbox.status()) === "running") return sandbox;
		await sandbox.terminate().catch(() => {});
		return null;
	} catch {
		return null;
	}
}

async function createSandbox(
	provider: SandboxProvider,
	token: string,
	repository: ReturnType<typeof factoryRepository>,
	issueNumber: number,
	attemptId: string,
): Promise<{ sandbox: Sandbox; state: ReadySandboxCheckpoint }> {
	const sandbox = await provider.create({
		timeoutSeconds: 24 * 60 * 60,
		metadata: {
			workflow: "spec-to-pr",
			repo: repository.fullName,
			issue: String(issueNumber),
			attempt: attemptId,
		},
	});
	try {
		await putCheckpoint<SandboxCheckpoint>(attemptId, "sandbox", {
			id: sandbox.id,
			ready: false,
		});
		const remoteUrl = githubRemoteUrl(repository.owner, repository.repo);
		const clone = await execGitWithToken(sandbox, token, [
			"git",
			"clone",
			"--depth=50",
			remoteUrl,
			REPO_DIR,
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
		const branch = branchName(issueNumber, attemptId);

		await runCommand(
			sandbox,
			`git -C ${shellEscape(REPO_DIR)} checkout -b ${shellEscape(branch)} ${shellEscape(remoteHead)} && ` +
				`git -C ${shellEscape(REPO_DIR)} config user.name "render-factory[bot]" && ` +
				`git -C ${shellEscape(REPO_DIR)} config user.email "bot@render-factory.dev"`,
			"Repository setup",
		);
		const state = {
			id: sandbox.id,
			ready: true as const,
			remoteUrl,
			remoteHead,
			base,
			baseSha,
			branch,
		};
		await putCheckpoint(attemptId, "sandbox", state);
		return { sandbox, state };
	} catch (error) {
		await sandbox.terminate().catch(() => {});
		throw error;
	}
}

async function getOrCreateSandbox(
	provider: SandboxProvider,
	token: string,
	repository: ReturnType<typeof factoryRepository>,
	issueNumber: number,
	attemptId: string,
): Promise<{ sandbox: Sandbox; state: ReadySandboxCheckpoint }> {
	const saved = await getCheckpoint<SandboxCheckpoint>(attemptId, "sandbox");
	if (saved.found && saved.value.ready) {
		const sandbox = await connectCheckpointedSandbox(provider, saved.value);
		if (sandbox) return { sandbox, state: saved.value };
		await clearCheckpoints(attemptId, DOWNSTREAM_STAGES);
	} else if (saved.found) {
		try {
			await (await provider.connect(saved.value.id)).terminate();
		} catch {
			// A partially-created sandbox may already be gone.
		}
		await clearCheckpoints(attemptId, DOWNSTREAM_STAGES);
	}
	return createSandbox(provider, token, repository, issueNumber, attemptId);
}

function requireImplementationReport(raw: string): ImplementationReport {
	const report = parseModelJson(implementationSchema, raw);
	if (!report) {
		throw new Error("Implementer returned invalid structured output");
	}
	if (report.verification.some((check) => !check.passed)) {
		throw new Error("Implementer reported a failing verification command");
	}
	return report;
}

async function runImplementation(
	message: string,
	sandboxId: string,
): Promise<ImplementationCheckpoint> {
	const raw = await resolveTaskResult(
		await implementTask({ message, sandboxId }),
	);
	return { raw, report: requireImplementationReport(raw) };
}

async function ensureCommit(
	sandbox: Sandbox,
	state: ReadySandboxCheckpoint,
	previousSha: string,
	message: string,
): Promise<CommitCheckpoint | null> {
	await runCommand(
		sandbox,
		`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} checkout ${shellEscape(state.branch)}`,
		"Branch verification",
	);
	await runCommand(
		sandbox,
		`git -C ${shellEscape(REPO_DIR)} add -A`,
		"Git add",
	);
	const diffCheck = await sandbox.exec(
		`git -C ${shellEscape(REPO_DIR)} diff --cached --quiet`,
	);
	const { exitCode, output } = await collectExecOutput(diffCheck);
	if (exitCode === 0) {
		const head = (
			await runCommand(
				sandbox,
				`git -C ${shellEscape(REPO_DIR)} rev-parse HEAD`,
				"Current revision",
			)
		).trim();
		return head === previousSha ? null : { sha: head };
	}
	if (exitCode !== 1) {
		throw new Error(`Git diff check failed: ${output.slice(0, 500)}`);
	}

	await runCommand(
		sandbox,
		`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} commit -m ${shellEscape(message)}`,
		"Commit",
	);
	const sha = (
		await runCommand(
			sandbox,
			`git -C ${shellEscape(REPO_DIR)} rev-parse HEAD`,
			"Committed revision",
		)
	).trim();
	return { sha };
}

async function completeDiff(
	sandbox: Sandbox,
	state: ReadySandboxCheckpoint,
	headSha: string,
): Promise<string> {
	const diff = await runCommand(
		sandbox,
		`git -C ${shellEscape(REPO_DIR)} diff --no-ext-diff ${shellEscape(state.baseSha)}...${shellEscape(headSha)}`,
		"Git diff",
	);
	if (diff.length > MAX_REVIEW_DIFF_CHARS) {
		throw new Error("Diff is too large for complete automated review");
	}
	if (/^Binary files .* differ$/m.test(diff)) {
		throw new Error("Binary changes require human review");
	}
	return diff;
}

async function runReview(
	diff: string,
	implementation: ImplementationCheckpoint,
): Promise<ReviewDecision> {
	const [securityReview, correctnessReview, testReview] = await Promise.all(
		[
			securityTask({ message: diff }),
			correctnessTask({ message: diff }),
			testsTask({
				message: `${implementation.raw}\n\nComplete diff:\n${diff}`,
			}),
		].map(async (result) => resolveTaskResult(await result)),
	);
	const details = [
		`## Security\n${securityReview}`,
		`## Correctness\n${correctnessReview}`,
		`## Tests\n${testReview}`,
	].join("\n\n");
	const judgeRaw = await resolveTaskResult(
		await judgeTask({ message: `${details}\n\nComplete diff:\n${diff}` }),
	);
	const decision = await parseWithRepair(
		decisionSchema,
		judgeRaw,
		"judge",
		async () =>
			await judgeTask({
				message: `${details}\n\nComplete diff:\n${diff}\n\nYour previous response was not valid JSON. Return only the required JSON object.`,
			}),
	);
	return {
		decision: decision.decision,
		summary: decision.summary,
		details,
	};
}

async function verifyPush(
	sandbox: Sandbox,
	token: string,
	state: ReadySandboxCheckpoint,
	expectedSha: string,
): Promise<{ sha: string }> {
	const push = await execGitWithToken(sandbox, token, [
		"git",
		"-C",
		REPO_DIR,
		"push",
		state.remoteUrl,
		`refs/heads/${state.branch}:refs/heads/${state.branch}`,
	]);
	if (push.exitCode !== 0) {
		throw new Error(`Push failed: ${push.output.slice(0, 500)}`);
	}
	const remote = await execGitWithToken(sandbox, token, [
		"git",
		"ls-remote",
		state.remoteUrl,
		`refs/heads/${state.branch}`,
	]);
	if (remote.exitCode !== 0) {
		throw new Error(`Push verification failed: ${remote.output.slice(0, 500)}`);
	}
	const pushedSha = remote.output.trim().split(/\s+/)[0];
	if (pushedSha !== expectedSha) {
		throw new Error("Pushed branch SHA does not match the reviewed commit");
	}
	return { sha: pushedSha };
}

async function finish(
	repository: string,
	issueNumber: number,
	attemptId: string,
	result: WorkflowResult,
): Promise<WorkflowResult> {
	await putCheckpoint(attemptId, "result", result);
	await completeIntake(repository, issueNumber, attemptId);
	return result;
}

async function recordFailure(
	gh: GitHub,
	repo: RepoRef,
	repository: string,
	issueNumber: number,
	attemptId: string,
	triggerLabel: string,
): Promise<boolean> {
	const failureCount = await incrementFailureCount(attemptId);
	if (failureCount < 3) return false;

	await gh
		.ensureIssueComment(
			repo,
			issueNumber,
			operationId(attemptId, "failed"),
			`The factory run failed after three attempts. Reapply the \`${triggerLabel}\` label to start a new attempt.`,
		)
		.catch(() => {});
	await completeIntake(repository, issueNumber, attemptId).catch(() => {});
	return true;
}

export const specToPr = task(
	{
		name: "spec-to-pr",
		plan: "standard",
		retry: { maxRetries: 2, waitDurationMs: 45_000, backoffScaling: 2 },
		timeoutSeconds: 24 * 60 * 60,
	},
	async function specToPr(rawInput: unknown): Promise<WorkflowResult> {
		const { issueNumber, attemptId } = inputSchema.parse(rawInput);
		const repository = factoryRepository();
		const repo: RepoRef = repository;
		const triggerLabel = factoryLabel();
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN is not set");

		const priorResult = await getCheckpoint<WorkflowResult>(
			attemptId,
			"result",
		);
		if (priorResult.found) {
			const provider = new RenderSandboxProvider();
			const saved = await getCheckpoint<SandboxCheckpoint>(
				attemptId,
				"sandbox",
			);
			if (saved.found) {
				try {
					await (await provider.connect(saved.value.id)).terminate();
				} catch {
					// The prior terminal attempt may already have removed it.
				}
			}
			await completeIntake(repository.fullName, issueNumber, attemptId);
			return priorResult.value;
		}

		const executionId = randomUUID();
		if (!(await claimExecution(attemptId, executionId))) {
			return { skipped: "attempt is already running" };
		}
		let heartbeatError: Error | undefined;
		const heartbeat = setInterval(() => {
			void Promise.all([
				refreshExecution(attemptId, executionId),
				refreshIntakeLease(repository.fullName, issueNumber, attemptId),
			]).catch((error) => {
				heartbeatError =
					error instanceof Error ? error : new Error(String(error));
			});
		}, 10_000);
		heartbeat.unref();
		const assertHeartbeat = () => {
			if (heartbeatError) throw heartbeatError;
		};
		const releaseExecutionLock = async () => {
			clearInterval(heartbeat);
			await releaseExecution(attemptId, executionId).catch(() => {});
		};

		const gh = githubFromEnv();
		let intake: IntakeCheckpoint;
		try {
			intake = await checkpoint(
				repository.fullName,
				issueNumber,
				attemptId,
				"intake",
				() => loadIntake(gh, repo, issueNumber, triggerLabel),
				false,
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
					operationId(attemptId, "clarification"),
					`The factory needs more detail before it can proceed:\n\n${questions
						.map((question, index) => `${index + 1}. ${question}`)
						.join(
							"\n",
						)}\n\nReply with the details, then reapply the \`${triggerLabel}\` label.`,
				);
				const result = await finish(
					repository.fullName,
					issueNumber,
					attemptId,
					{
						status: "needs_clarification",
						questions,
					},
				);
				await releaseExecutionLock();
				return result;
			}
		} catch (error) {
			await recordFailure(
				gh,
				repo,
				repository.fullName,
				issueNumber,
				attemptId,
				triggerLabel,
			).catch(() => {});
			await releaseExecutionLock();
			throw error;
		}

		let sandbox: Sandbox | undefined;
		let terminal = false;
		try {
			const provider = new RenderSandboxProvider();
			const sandboxResult = await getOrCreateSandbox(
				provider,
				token,
				repository,
				issueNumber,
				attemptId,
			);
			const activeSandbox = sandboxResult.sandbox;
			sandbox = activeSandbox;
			const sandboxState = sandboxResult.state;
			const context = sandboxContext();
			assertHeartbeat();

			const analysis = await checkpoint(
				repository.fullName,
				issueNumber,
				attemptId,
				"analysis",
				async () =>
					resolveTaskResult(
						await analysisTask({
							message: `${context}\n\nWork item:\n${intake.workItem}`,
							sandboxId: activeSandbox.id,
						}),
					),
				false,
			);
			const implementation1 = await checkpoint(
				repository.fullName,
				issueNumber,
				attemptId,
				"implementation-1",
				() =>
					runImplementation(
						`${context}\n\nWork item:\n${intake.workItem}\n\nApproved analysis:\n${analysis}`,
						activeSandbox.id,
					),
				false,
			);
			const commit1 = await checkpoint(
				repository.fullName,
				issueNumber,
				attemptId,
				"commit-1",
				() =>
					ensureCommit(
						activeSandbox,
						sandboxState,
						sandboxState.baseSha,
						`Implement issue #${issueNumber}: ${intake.issue.title}`,
					),
			);
			if (!commit1) {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(attemptId, "no-changes"),
					`The factory produced no repository changes. Reapply the \`${triggerLabel}\` label to retry.`,
				);
				terminal = true;
				return finish(repository.fullName, issueNumber, attemptId, {
					status: "no_changes",
				});
			}

			const diff1 = await completeDiff(
				activeSandbox,
				sandboxState,
				commit1.sha,
			);
			const review1 = await checkpoint(
				repository.fullName,
				issueNumber,
				attemptId,
				"review-1",
				() => runReview(diff1, implementation1),
				false,
			);

			let finalCommit = commit1;
			let finalImplementation = implementation1;
			let finalReview = review1;
			if (review1.decision === "request_changes") {
				finalImplementation = await checkpoint(
					repository.fullName,
					issueNumber,
					attemptId,
					"implementation-2",
					() =>
						runImplementation(
							`${context}\n\nRevise the existing implementation for this work item:\n${intake.workItem}\n\n` +
								`Original analysis:\n${analysis}\n\nBlocking internal review:\n${review1.summary}\n\n${review1.details}`,
							activeSandbox.id,
						),
					false,
				);
				const commit2 = await checkpoint(
					repository.fullName,
					issueNumber,
					attemptId,
					"commit-2",
					() =>
						ensureCommit(
							activeSandbox,
							sandboxState,
							commit1.sha,
							`Address internal review for issue #${issueNumber}`,
						),
				);
				if (!commit2) {
					finalReview = {
						decision: "request_changes",
						summary: "The revision produced no changes.",
						details: review1.details,
					};
				} else {
					finalCommit = commit2;
					const diff2 = await completeDiff(
						activeSandbox,
						sandboxState,
						commit2.sha,
					);
					finalReview = await checkpoint(
						repository.fullName,
						issueNumber,
						attemptId,
						"review-2",
						() => runReview(diff2, finalImplementation),
						false,
					);
				}
			}

			if (finalReview.decision !== "approve") {
				await gh.ensureIssueComment(
					repo,
					issueNumber,
					operationId(attemptId, "changes-requested"),
					`The factory stopped after its revision still needed changes:\n\n${finalReview.summary}\n\n` +
						`Reapply the \`${triggerLabel}\` label after updating the issue or repository.`,
				);
				terminal = true;
				return finish(repository.fullName, issueNumber, attemptId, {
					status: "changes_requested",
					summary: finalReview.summary,
				});
			}

			assertHeartbeat();
			await checkpoint(
				repository.fullName,
				issueNumber,
				attemptId,
				"push",
				() => verifyPush(activeSandbox, token, sandboxState, finalCommit.sha),
			);
			const pull = await checkpoint<PullCheckpoint>(
				repository.fullName,
				issueNumber,
				attemptId,
				"pull-request",
				async () => {
					const result = await gh.ensurePull(repo, {
						title: `Fix #${issueNumber}: ${intake.issue.title}`,
						head: sandboxState.branch,
						base: sandboxState.base,
						draft: true,
						expectedHeadSha: finalCommit.sha,
						body:
							`Automated implementation for #${issueNumber}.\n\n` +
							`## Internal review: approved\n\n${finalReview.summary}\n\n` +
							`## Implementation report\n\n${finalImplementation.raw}\n\nCloses #${issueNumber}.`,
					});
					return { htmlUrl: result.htmlUrl };
				},
			);
			await gh.ensureIssueComment(
				repo,
				issueNumber,
				operationId(attemptId, "draft-pr"),
				`The factory opened a reviewed draft pull request: ${pull.htmlUrl}`,
			);
			terminal = true;
			return finish(repository.fullName, issueNumber, attemptId, {
				status: "draft_pr_opened",
				decision: "approve",
				pullRequest: pull.htmlUrl,
			});
		} catch (error) {
			terminal = await recordFailure(
				gh,
				repo,
				repository.fullName,
				issueNumber,
				attemptId,
				triggerLabel,
			).catch(() => false);
			throw error;
		} finally {
			await releaseExecutionLock();
			if (terminal) await sandbox?.terminate().catch(() => {});
		}
	},
);
