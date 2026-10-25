import type { TaskDefinition } from "@renderinc/sdk/workflows";
import type { Claim, Outcome, TaskResult } from "../../claims/index.js";
import { config, TASKS } from "../../config/index.js";
import { AutopilotInput, type PrReviewInput, type SpecToPrInput, type TriageInput } from "../../schemas/index.js";
import { prReviewWorkflow } from "../pr-review/index.js";
import { type SpecToPrHandoff, specToPrWorkflow } from "../spec-to-pr/index.js";
import { triageWorkflow } from "../triage/index.js";
import type { TriageHandoff } from "../triage/spec.js";
import { defineGitHubTask, type GitHubTaskContext, type GitHubTaskDeps } from "../github-task.js";

const TIMEOUT_SECONDS = 8 * 60 * 60;

type StageName = "triage" | "spec-to-pr" | "pr-review";
type StageTaskResult = TaskResult<TriageHandoff | SpecToPrHandoff | undefined>;

export interface AutopilotStage {
	task: StageName;
	runId: string;
	state: TaskResult["state"];
	outcome: string;
	summary: string;
}

export interface AutopilotData {
	stages: AutopilotStage[];
}

export interface AutopilotDeps extends GitHubTaskDeps {
	triage?: (input: TriageInput) => Promise<TaskResult<TriageHandoff>>;
	specToPr?: (input: SpecToPrInput) => Promise<TaskResult<SpecToPrHandoff>>;
	prReview?: (input: PrReviewInput) => Promise<TaskResult>;
}

/**
 * Runs the three built-in GitHub tasks as children of one issue-level root.
 * Child results, not GitHub labels, move the workflow to its next stage.
 */
async function autopilot(claim: Claim, input: TriageInput, deps: AutopilotDeps, ctx: GitHubTaskContext): Promise<Outcome<AutopilotData>> {
	const gh = claim.gh;
	const stages: AutopilotStage[] = [];
	const record = <Data>(task: StageName, result: TaskResult<Data>): TaskResult<Data> => {
		stages.push({ task, runId: result.runId, state: result.state, outcome: result.outcome, summary: result.summary });
		return result;
	};
	const finish = (outcome: string, summary: string, state?: "done" | "failed"): Outcome<AutopilotData> => ({
		outcome,
		summary,
		state,
		data: { stages },
	});
	const stop = (task: StageName, result: StageTaskResult): Outcome<AutopilotData> => {
		const state = result.state === "done" ? "done" : "failed";
		return finish(`stopped_at_${task.replaceAll("-", "_")}`, result.summary, state);
	};
	const child = <Input, Data>(
		override: ((input: Input) => Promise<TaskResult<Data>>) | undefined,
		workflow: { task: TaskDefinition<[raw: unknown], TaskResult<Data>> },
	): ((input: Input) => Promise<TaskResult<Data>>) => {
		if (override) return override;
		if (!ctx.run) throw new Error("autopilot requires a Workflows task context");
		return (stageInput) => ctx.run?.(workflow.task, stageInput) as Promise<TaskResult<Data>>;
	};

	const runTriage = child(deps.triage, triageWorkflow);
	const runSpecToPr = child(deps.specToPr, specToPrWorkflow);
	const runPrReview = child(deps.prReview, prReviewWorkflow);

	const base = { repo: input.repo, installationId: input.installationId, actor: input.actor };
	// Trigger labels are consumed when a run starts. Autopilot adds its label
	// back only while it is waiting for a human answer.
	await gh.removeLabel(input.issue, config.labels.autopilot);
	await claim.reportProgress("running Triage");
	const triage = record("triage", await runTriage({ ...base, issue: input.issue, commentId: input.commentId }));
	if (triage.state === "done" && triage.outcome === "asked") {
		await claim.assertCurrent();
		await gh.addLabels(input.issue, [config.labels.autopilot]);
		return finish("waiting_for_answers", triage.summary);
	}
	if (triage.state !== "done" || triage.data?.kind !== "spec") return stop("triage", triage);

	await claim.reportProgress("implementing the spec");
	const specToPr = record(
		"spec-to-pr",
		await runSpecToPr({
			...base,
			issue: input.issue,
			approval: {
				kind: "autopilot",
				commentId: triage.data.commentId,
				hash: triage.data.hash,
				version: triage.data.version,
			},
		}),
	);
	if (specToPr.state !== "done" || specToPr.data?.kind !== "pull_request") return stop("spec-to-pr", specToPr);

	await claim.reportProgress("reviewing the draft pull request");
	const review = record(
		"pr-review",
		await runPrReview({ ...base, pr: specToPr.data.pr, headSha: specToPr.data.headSha, workflowIssue: input.issue }),
	);
	if (review.state !== "done" || !["reviewed", "already_reviewed"].includes(review.outcome)) return stop("pr-review", review);

	return finish("completed", `opened and reviewed draft PR #${specToPr.data.pr}.`);
}

export const autopilotWorkflow = defineGitHubTask(
	{
		name: TASKS.autopilot,
		title: "Autopilot",
		input: AutopilotInput,
		subject: (input) => ({ kind: "issue", number: input.issue }),
		timeoutSeconds: TIMEOUT_SECONDS,
	},
	autopilot,
);

export const runAutopilot = autopilotWorkflow.run;
