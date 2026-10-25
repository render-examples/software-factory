import { implementer, runAgent } from "../../agents/index.js";
import { publish } from "../../changeset/index.js";
import { ExpectedFailure, type Outcome } from "../../claims/index.js";
import { config, type RepoContext, TASKS } from "../../config/index.js";
import { pullRequestBody, pullRequestTitle } from "../../format/index.js";
import { type GitDataClient, gitData } from "../../github/index.js";
import { type OpenedSandbox, openSandbox, type SandboxRef, withSandbox } from "../../sandbox/index.js";
import { type Implementation, SpecToPrInput } from "../../schemas/index.js";
import { defineGitHubTask, type GitHubTaskDeps } from "../github-task.js";
import { runVerify, type VerifyRun } from "../run-verify.js";
import { loadApprovedSpec } from "./approval.js";
import { botIdentity, branchName, commitDate, commitMessage, ownedCommits, refusalSummary } from "./branch.js";
import { implementMessage, mergeImplementation, repairMessage } from "./messages.js";
import { allPassed, failureSummary, hasChanges } from "./verify.js";

const IMPLEMENT_TIMEOUT_MS = 60 * 60 * 1000;

/** The draft pull request a parent task may pass to its next stage. */
export interface SpecToPrHandoff {
	kind: "pull_request";
	pr: number;
	headSha: string;
}

/** Test seams; each defaults to the real thing. */
export interface SpecToPrDeps extends GitHubTaskDeps {
	gitData?: GitDataClient;
	openSandbox?: (repo: RepoContext, ref: SandboxRef) => Promise<OpenedSandbox>;
	runAgent?: typeof runAgent;
	publish?: typeof publish;
	now?: () => Date;
}

/**
 * Approved spec to draft PR: implement in one sandbox, verify with up to `limits.repairRounds` repair runs, then
 * publish through the Git Data API and open a draft PR. A rerun (a relabel) replaces the earlier attempt's branch.
 */
export const specToPrWorkflow = defineGitHubTask(
	{
		name: TASKS.specToPr,
		title: "Spec-to-PR",
		input: SpecToPrInput,
		subject: (input) => ({ kind: "issue", number: input.issue }),
		timeoutSeconds: 4 * 60 * 60,
	},
	async (claim, input, deps: SpecToPrDeps): Promise<Outcome<SpecToPrHandoff>> => {
		const { gh, repo } = claim;
		// Fixed for the whole run, so publishing the same tree twice produces the same commit.
		const date = commitDate((deps.now ?? (() => new Date()))());
		const { spec, comment } = await loadApprovedSpec(gh, input.issue, input.approval);
		const issue = await gh.getIssue(input.issue);
		if (issue.isPull) throw new ExpectedFailure("Spec-to-PR runs on issues, not pull requests.", "not_an_issue");
		const author = await botIdentity(gh, date);
		const git = deps.gitData ?? gitData(repo);
		const branch = branchName(input.issue);
		const rounds = config.limits.repairRounds;

		await claim.progress("opening a sandbox");
		const open = () => (deps.openSandbox ?? openSandbox)(repo, { kind: "branch", name: repo.config.baseBranch });
		return withSandbox(open, async (sandbox) => {
			await claim.recordSandbox(sandbox);
			const baseSha = sandbox.headSha;
			const implement = async (message: string): Promise<Implementation> =>
				(await (deps.runAgent ?? runAgent)(implementer, message, { ...claim.agentOptions(sandbox), timeoutMs: IMPLEMENT_TIMEOUT_MS })).output;

			const owned = await ownedCommits(git, branch, baseSha, author);

			await claim.progress("implementing the spec");
			let implementation = await implement(implementMessage(repo, issue, spec));
			if (!(await hasChanges(sandbox))) return noChanges();

			let verification: VerifyRun[];
			for (let round = 1; ; round++) {
				await claim.progress("running the verify commands");
				verification = await runVerify(sandbox, repo.config.verify);
				if (allPassed(verification)) break;
				if (round > rounds) {
					const after = rounds > 0 ? ` after ${rounds} repair round${rounds === 1 ? "" : "s"}` : "";
					throw new ExpectedFailure(`verification failed${after}: ${failureSummary(verification)}. No PR was opened.`, "verification_failed");
				}
				await claim.progress(`repairing failed verification (round ${round} of ${rounds})`);
				implementation = mergeImplementation(implementation, await implement(repairMessage(repo, issue, spec, verification, round, rounds)));
			}

			await claim.progress("publishing the branch");
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
				throw new ExpectedFailure(refusalSummary(published.refused), "publish_refused");
			}

			await claim.progress("opening the draft pull request");
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
				data: { kind: "pull_request", pr: pull.number, headSha: pull.headSha },
			};
		});
	},
);

export const runSpecToPr = specToPrWorkflow.run;

const noChanges = (): Outcome<SpecToPrHandoff> => ({
	outcome: "no_changes",
	summary: "the implementation agent made no changes, so there is nothing to open a PR for.",
});
