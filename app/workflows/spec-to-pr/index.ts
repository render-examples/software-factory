import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { AgentError, implementer, runAgent, selfReview, verifyCommandsVar } from "../../agents/index.js";
import { config, type RepoContext, requireRepo, TASKS } from "../../config/index.js";
import type { Implementation, SelfReview } from "../../contracts/index.js";
import { SpecToPrInput } from "../../contracts/tasks.js";
import { pullRequestBody, pullRequestTitle } from "../../format/index.js";
import { type GitDataClient, type GitHubClient, gitData, githubFor } from "../../github/index.js";
import { PhaseError, type PhaseOutcome, type PhaseResult, type RunControl, withPhase } from "../../phases/index.js";
import { publish } from "../../publish/index.js";
import { type OpenedSandbox, openSandbox, type SandboxRef } from "../../sandbox/index.js";
import {
	agentStopped,
	implementMessage,
	mergeImplementation,
	repairMessage,
	revisionMessage,
	selfReviewMessage,
	selfReviewSkipped,
} from "./agents.js";
import { loadApprovedSpec } from "./approval.js";
import { botIdentity, branchName, commitDate, commitMessage, ownedCommits, refusalSummary } from "./branch.js";
import { allPassed, failureSummary, hasChanges, runVerify, type VerifyRun } from "./verify.js";

const TASK_TIMEOUT_SECONDS = 4 * 60 * 60;
const IMPLEMENT_TIMEOUT_MS = 60 * 60 * 1000;

/** Test seams; each defaults to the real thing. */
export interface SpecToPrDeps {
	gh?: GitHubClient;
	runs?: RunControl;
	gitData?: GitDataClient;
	openSandbox?: (repo: RepoContext, ref: SandboxRef) => Promise<OpenedSandbox>;
	runAgent?: typeof runAgent;
	publish?: typeof publish;
	now?: () => Date;
}

/**
 * Approved spec to draft PR: implement in one sandbox, verify with up to `limits.repairRounds` repair runs,
 * self-review with at most one revision, then publish through the Git Data API and open a draft PR.
 */
export async function runSpecToPr(ctx: Pick<TaskContext, "metadata">, raw: unknown, deps: SpecToPrDeps = {}): Promise<PhaseOutcome> {
	const input = SpecToPrInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId);
	const gh = deps.gh ?? githubFor(repo);
	const runAgentFn = deps.runAgent ?? runAgent;
	// Fixed for the whole run, so publishing the same tree twice produces the same commit.
	const date = commitDate((deps.now ?? (() => new Date()))());
	const subject = { kind: "issue", number: input.issue } as const;

	return withPhase(ctx, { repo, subject, phase: TASKS.specToPr, actor: input.actor, gh, runs: deps.runs }, async (run) => {
		const { spec, comment } = await loadApprovedSpec(gh, input.issue, input.labeledAt);
		const issue = await gh.getIssue(input.issue);
		if (issue.isPull) throw new PhaseError("Spec-to-PR runs on issues, not pull requests.", "not_an_issue");
		const author = await botIdentity(gh, date);
		const git = deps.gitData ?? gitData(repo);
		const branch = branchName(input.issue);
		const rounds = config.limits.repairRounds;

		await run.progress("opening a sandbox");
		const sandbox = await (deps.openSandbox ?? openSandbox)(repo, { kind: "branch", name: repo.config.baseBranch });
		const baseSha = sandbox.headSha;
		const agentOpts = { sandbox, traceId: run.traceId, runId: run.runId, repo: repo.fullName, subject: `issue#${input.issue}` };
		const noChanges = (): PhaseResult => ({
			outcome: "no_changes",
			summary: "the implementation agent made no changes, so there is nothing to open a PR for.",
		});

		const implement = async (message: string): Promise<Implementation> => {
			const vars = { repo: repo.fullName, verifyCommands: verifyCommandsVar(repo.config.verify) };
			const call = (budgetUsd: number) => runAgentFn(implementer, { message, vars }, { ...agentOpts, budgetUsd, timeoutMs: IMPLEMENT_TIMEOUT_MS });
			return (await run.budget.track(call)).output;
		};

		// Self-review is advisory: when it can't finish, the verified change still publishes, with a note saying so.
		const reviewChange = async (implementation: Implementation): Promise<SelfReview> => {
			const message = selfReviewMessage(issue, spec, implementation);
			try {
				const call = (budgetUsd: number) => runAgentFn(selfReview, { message, vars: { repo: repo.fullName, baseRef: baseSha } }, { ...agentOpts, budgetUsd });
				return (await run.budget.track(call)).output;
			} catch (err) {
				if (err instanceof AgentError) return selfReviewSkipped(err);
				throw err;
			}
		};

		try {
			const owned = await ownedCommits(git, branch, baseSha, author);

			await run.progress("implementing the spec");
			let implementation = await implement(implementMessage(issue, spec));
			if (!(await hasChanges(sandbox))) return noChanges();

			// Repair rounds are shared by the whole run: the verify after a self-review revision gets what's left.
			let repairsLeft = rounds;
			const verifyAndRepair = async (): Promise<VerifyRun[]> => {
				for (;;) {
					await run.progress("running the verify commands");
					const results = await runVerify(sandbox, repo.config.verify);
					if (allPassed(results)) return results;
					if (repairsLeft === 0) {
						const after = rounds > 0 ? ` after ${rounds} repair round${rounds === 1 ? "" : "s"}` : "";
						throw new PhaseError(`verification failed${after}: ${failureSummary(results)}. No PR was opened.`, "verification_failed");
					}
					const round = rounds - --repairsLeft;
					await run.progress(`repairing failed verification (round ${round} of ${rounds})`);
					implementation = mergeImplementation(implementation, await implement(repairMessage(issue, spec, results, round, rounds)));
				}
			};
			let verification = await verifyAndRepair();

			await run.progress("reviewing the change");
			let review = await reviewChange(implementation);
			if (review.needsRevision) {
				await run.progress("revising the change after self-review");
				implementation = mergeImplementation(implementation, await implement(revisionMessage(issue, spec, review)));
				verification = await verifyAndRepair();
				review = { ...review, notes: [...review.notes, "The implementation agent revised the change for the issues below before this PR opened."] };
			}

			await run.progress("publishing the branch");
			const published = await (deps.publish ?? publish)({
				sandbox,
				repo,
				baseSha,
				branch,
				message: commitMessage(spec, input.issue),
				author,
				ownedCommits: owned,
				gitData: git,
			});
			if ("refused" in published) {
				if (published.refused.every((r) => r.kind === "no_changes")) return noChanges();
				throw new PhaseError(refusalSummary(published.refused), "publish_refused");
			}

			await run.progress("opening the draft pull request");
			const { pull } = await gh.findOrCreatePull({
				head: branch,
				base: repo.config.baseBranch,
				title: pullRequestTitle(spec),
				body: pullRequestBody({ issue: input.issue, spec, implementation, selfReview: review, verification, specUrl: comment.htmlUrl }),
				draft: true,
			});
			return {
				outcome: "pr_opened",
				summary: `opened draft PR #${pull.number}. Review it before marking it ready.`,
				links: [{ label: `Draft PR #${pull.number}`, url: pull.htmlUrl }],
			};
		} catch (err) {
			const expected = err instanceof PhaseError ? err : agentStopped(err, "implementation agent");
			if (expected) return { outcome: expected.outcome, summary: expected.message, state: "failed" };
			throw err;
		} finally {
			await sandbox.close().catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				console.error(JSON.stringify({ level: "warn", msg: "could not close sandbox", sandboxId: sandbox.id, error: message }));
			});
		}
	});
}

/** Not retried: a rerun is a relabel, and it replaces the earlier attempt's branch. */
export const specToPr = task(
	{ name: TASKS.specToPr, timeoutSeconds: TASK_TIMEOUT_SECONDS, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
	(ctx, raw: unknown) => runSpecToPr(ctx, raw),
);
