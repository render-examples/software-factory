import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { implementer, runAgent } from "../../agents/index.js";
import { config, type RepoContext, requireRepo, TASKS } from "../../config/index.js";
import type { Implementation } from "../../schemas/index.js";
import { SpecToPrInput } from "../../schemas/tasks.js";
import { pullRequestBody, pullRequestTitle } from "../../format/index.js";
import { type GitDataClient, type GitHubClient, gitData, githubFor } from "../../github/index.js";
import { RunError, type RunOutcome, type RunResult, type RunControl, withRun } from "../../runs/index.js";
import { publish } from "../../changeset/index.js";
import { type OpenedSandbox, openSandbox, type SandboxRef, withSandbox } from "../../sandbox/index.js";
import { runVerify, type VerifyRun } from "../run-verify.js";
import { implementMessage, mergeImplementation, repairMessage } from "./agents.js";
import { loadApprovedSpec } from "./approval.js";
import { botIdentity, branchName, commitDate, commitMessage, ownedCommits, refusalSummary } from "./branch.js";
import { allPassed, failureSummary, hasChanges } from "./verify.js";

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
 * Approved spec to draft PR: implement in one sandbox, verify with up to `limits.repairRounds` repair runs, then
 * publish through the Git Data API and open a draft PR.
 */
export async function runSpecToPr(ctx: Pick<TaskContext, "metadata">, raw: unknown, deps: SpecToPrDeps = {}): Promise<RunOutcome> {
	const input = SpecToPrInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId);
	const gh = deps.gh ?? githubFor(repo);
	const runAgentFn = deps.runAgent ?? runAgent;
	// Fixed for the whole run, so publishing the same tree twice produces the same commit.
	const date = commitDate((deps.now ?? (() => new Date()))());
	const subject = { kind: "issue", number: input.issue } as const;

	return withRun(ctx, { repo, subject, stage: TASKS.specToPr, actor: input.actor, gh, runs: deps.runs }, async (run) => {
		const { spec, comment } = await loadApprovedSpec(gh, input.issue, input.labeledAt);
		const issue = await gh.getIssue(input.issue);
		if (issue.isPull) throw new RunError("Spec-to-PR runs on issues, not pull requests.", "not_an_issue");
		const author = await botIdentity(gh, date);
		const git = deps.gitData ?? gitData(repo);
		const branch = branchName(input.issue);
		const rounds = config.limits.repairRounds;

		await run.progress("opening a sandbox");
		const open = () => (deps.openSandbox ?? openSandbox)(repo, { kind: "branch", name: repo.config.baseBranch });
		return withSandbox(open, async (sandbox) => {
			const baseSha = sandbox.headSha;
			const agentOpts = { sandbox, traceId: run.traceId, runId: run.runId, repo: repo.fullName, subject: `issue#${input.issue}` };
			const implement = async (message: string): Promise<Implementation> =>
				(await runAgentFn(implementer, message, { ...agentOpts, timeoutMs: IMPLEMENT_TIMEOUT_MS })).output;

			const owned = await ownedCommits(git, branch, baseSha, author);

			await run.progress("implementing the spec");
			let implementation = await implement(implementMessage(repo, issue, spec));
			if (!(await hasChanges(sandbox))) return noChanges();

			let verification: VerifyRun[];
			for (let round = 1; ; round++) {
				await run.progress("running the verify commands");
				verification = await runVerify(sandbox, repo.config.verify);
				if (allPassed(verification)) break;
				if (round > rounds) {
					const after = rounds > 0 ? ` after ${rounds} repair round${rounds === 1 ? "" : "s"}` : "";
					throw new RunError(`verification failed${after}: ${failureSummary(verification)}. No PR was opened.`, "verification_failed");
				}
				await run.progress(`repairing failed verification (round ${round} of ${rounds})`);
				implementation = mergeImplementation(implementation, await implement(repairMessage(repo, issue, spec, verification, round, rounds)));
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
				throw new RunError(refusalSummary(published.refused), "publish_refused");
			}

			await run.progress("opening the draft pull request");
			const { pull } = await gh.findOrCreatePull({
				head: branch,
				base: repo.config.baseBranch,
				title: pullRequestTitle(spec),
				body: pullRequestBody({ issue: input.issue, spec, implementation, verification, specUrl: comment.htmlUrl }),
				draft: true,
			});
			return {
				outcome: "pr_opened",
				summary: `opened draft PR #${pull.number}. Review it before marking it ready.`,
				links: [{ label: `Draft PR #${pull.number}`, url: pull.htmlUrl }],
			};
		});
	});
}

const noChanges = (): RunResult => ({
	outcome: "no_changes",
	summary: "the implementation agent made no changes, so there is nothing to open a PR for.",
});

/** Not retried: a rerun is a relabel, and it replaces the earlier attempt's branch. */
export const specToPr = task(
	{ name: TASKS.specToPr, timeoutSeconds: TASK_TIMEOUT_SECONDS, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
	(ctx, raw: unknown) => runSpecToPr(ctx, raw),
);
