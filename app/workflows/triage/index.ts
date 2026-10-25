import { runAgent } from "../../agents/index.js";
import type { Outcome } from "../../claims/index.js";
import { type RepoContext, TASKS } from "../../config/index.js";
import { triageDeclineBody, triageQuestionsBody } from "../../format/index.js";
import { renderMarker } from "../../github/index.js";
import { openSandbox, type Sandbox, type SandboxRef, withSandbox } from "../../sandbox/index.js";
import { TriageInput } from "../../schemas/index.js";
import { defineGitHubTask, type GitHubTaskDeps } from "../github-task.js";
import { type AgentRunner, triageAgents } from "./agents.js";
import { draftSpec, publishSpec, type TriageHandoff } from "./spec.js";
import { readThread, specWriterMessage, triageMessage } from "./thread.js";

/** Test seams; production uses the real GitHub client, sandboxes, and runAgent. */
export interface TriageDeps extends GitHubTaskDeps {
	openSandbox?: (repo: RepoContext, ref: SandboxRef) => Promise<Sandbox>;
	runAgent?: AgentRunner;
}

/**
 * Triage one issue: the triage agent reads the issue and the repository and decides to ask questions, draft
 * (or revise) the spec, or decline. Every GitHub write goes through the format helpers and carries a marker.
 */
export const triageWorkflow = defineGitHubTask(
	{ name: TASKS.triage, title: "Triage", input: TriageInput, subject: (input) => ({ kind: "issue", number: input.issue }), timeoutSeconds: 3600 },
	async (claim, input, deps: TriageDeps): Promise<Outcome<TriageHandoff>> => {
		const { gh, repo } = claim;
		const [issue, comments, bot] = await Promise.all([gh.getIssue(input.issue), gh.listIssueComments(input.issue), gh.botLogin()]);
		if (input.commentId !== undefined) {
			const trigger = comments.find((c) => c.id === input.commentId);
			if (!trigger || trigger.author.login.toLowerCase() === bot.toLowerCase()) {
				return { outcome: "skipped", summary: "the comment that started this run is the factory's own or no longer exists." };
			}
		}
		const thread = readThread(issue, comments, bot);

		await claim.progress("opening a sandbox");
		const open = () => (deps.openSandbox ?? openSandbox)(repo, { kind: "branch", name: repo.config.baseBranch });
		return withSandbox(open, async (sandbox) => {
			await claim.recordSandbox(sandbox);
			const agents = triageAgents(deps.runAgent ?? runAgent, claim.agentOptions(sandbox));
			await claim.progress("reading the issue and the repository");
			const decision = await agents.triage(triageMessage(repo.fullName, thread));

			if (decision.decision === "ask") {
				await claim.progress("posting questions");
				const round = thread.questions ? thread.questions.round + 1 : 1;
				const body = `${triageQuestionsBody(decision.questions)}\n\n${renderMarker("questions", { round, questions: decision.questions })}`;
				const comment = thread.questions ? await gh.updateComment(thread.questions.comment.id, body) : await gh.createComment(issue.number, body);
				const n = decision.questions.length;
				return { outcome: "asked", summary: `asked ${n} question${n === 1 ? "" : "s"}.`, links: [{ label: "Questions", url: comment.htmlUrl }] };
			}

			if (decision.decision === "decline") {
				await claim.progress("posting the decision");
				const comment = await gh.createComment(issue.number, triageDeclineBody(decision.rationale));
				return { outcome: "declined", summary: "declined the issue.", links: [{ label: "Reason", url: comment.htmlUrl }] };
			}

			await claim.progress(thread.spec ? "revising the spec" : "drafting the spec");
			const drafted = await draftSpec(agents, sandbox, specWriterMessage(repo.fullName, thread, decision));
			await claim.progress("posting the spec");
			return await publishSpec(gh, issue, thread.spec, drafted);
		});
	},
);

export const runTriage = triageWorkflow.run;
