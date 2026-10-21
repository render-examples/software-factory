import type { TaskContext } from "@renderinc/sdk/workflows";
import { task } from "@renderinc/sdk/workflows";
import { runAgent } from "../../agents/index.js";
import { type RepoContext, requireRepo, TASKS } from "../../config/index.js";
import { TriageInput } from "../../schemas/index.js";
import { triageDeclineBody, triageQuestionsBody } from "../../format/index.js";
import { type GitHubClient, renderMarker } from "../../github/index.js";
import { type RunOutcome, type RunResult, type RunControl, subjectName, withRun } from "../../runs/index.js";
import { openSandbox, type Sandbox, type SandboxRef } from "../../sandbox/index.js";
import { type AgentRunner, triageAgents } from "./agents.js";
import { draftSpec, publishSpec } from "./spec.js";
import { readThread, specWriterMessage, triageMessage } from "./thread.js";

/** Test seams; production uses the real GitHub client, sandboxes, and runAgent. */
export interface TriageDeps {
	gh?: GitHubClient;
	runs?: RunControl;
	openSandbox?: (repo: RepoContext, ref: SandboxRef) => Promise<Sandbox>;
	runAgent?: AgentRunner;
}

/**
 * Triage one issue: the triage agent reads the issue and the repository and decides to ask questions, draft
 * (or revise) the spec, or decline. Every GitHub write goes through the format helpers and carries a marker.
 */
export async function runTriage(ctx: Pick<TaskContext, "metadata">, raw: unknown, deps: TriageDeps = {}): Promise<RunOutcome> {
	const input = TriageInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId);
	const subject = { kind: "issue" as const, number: input.issue };
	const stage = { repo, subject, stage: TASKS.triage, actor: input.actor, gh: deps.gh, runs: deps.runs };

	return withRun(ctx, stage, async (run): Promise<RunResult> => {
		const { gh } = run;
		const [issue, comments, bot] = await Promise.all([gh.getIssue(input.issue), gh.listIssueComments(input.issue), gh.botLogin()]);
		if (input.commentId !== undefined) {
			const trigger = comments.find((c) => c.id === input.commentId);
			if (!trigger || trigger.author.login.toLowerCase() === bot.toLowerCase()) {
				return { outcome: "skipped", summary: "the comment that started this run is the factory's own or no longer exists." };
			}
		}
		const thread = readThread(issue, comments, bot);

		await run.progress("opening a sandbox");
		const sandbox = await (deps.openSandbox ?? openSandbox)(repo, { kind: "branch", name: repo.config.baseBranch });
		const agents = triageAgents(deps.runAgent ?? runAgent, {
			sandbox,
			traceId: run.traceId,
			runId: run.runId,
			repo: repo.fullName,
			subject: subjectName(subject),
		});
		try {
			await run.progress("reading the issue and the repository");
			const decision = await agents.triage(triageMessage(repo.fullName, thread));

			if (decision.decision === "ask") {
				await run.progress("posting questions");
				const round = thread.questions ? thread.questions.round + 1 : 1;
				const body = `${triageQuestionsBody(decision.questions)}\n\n${renderMarker("questions", { round, questions: decision.questions })}`;
				const comment = thread.questions
					? await gh.updateComment(thread.questions.comment.id, body)
					: await gh.createComment(issue.number, body);
				const n = decision.questions.length;
				return {
					outcome: "asked",
					summary: `asked ${n} question${n === 1 ? "" : "s"}.`,
					links: [{ label: "Questions", url: comment.htmlUrl }],
				};
			}

			if (decision.decision === "decline") {
				await run.progress("posting the decision");
				const comment = await gh.createComment(issue.number, triageDeclineBody(decision.rationale));
				return { outcome: "declined", summary: "declined the issue.", links: [{ label: "Reason", url: comment.htmlUrl }] };
			}

			await run.progress(thread.spec ? "revising the spec" : "drafting the spec");
			const drafted = await draftSpec(agents, sandbox, specWriterMessage(repo.fullName, thread, decision));
			await run.progress("posting the spec");
			return await publishSpec(gh, issue, thread.spec, drafted);
		} finally {
			await sandbox.close().catch((error: unknown) => {
				console.error(JSON.stringify({ level: "warn", msg: "could not close sandbox", sandbox: sandbox.id, error: String(error) }));
			});
		}
	});
}

/** Not retried: a retry would repeat agent spend; the next comment or relabel starts a fresh round. */
export const triage = task(
	{ name: TASKS.triage, timeoutSeconds: 3600, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
	(ctx, raw: unknown) => runTriage(ctx, raw),
);
