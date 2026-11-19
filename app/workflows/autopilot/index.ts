import type { TaskDefinition } from "@renderinc/sdk/workflows";
import { config, TASKS } from "../../config/index.js";
import type { Outcome, Run, TaskResult } from "../../runs/index.js";
import { AutopilotInput, type PrReviewInput, type SpecToPrInput, type TriageInput } from "../../schemas/index.js";
import { defineGitHubTask, type GitHubTaskContext, type GitHubTaskDeps } from "../github-task.js";
import { type SpecToPrHandoff, specToPrWorkflow } from "../spec-to-pr/index.js";
import { startTask } from "../start-task.js";
import { type TriageHandoff, triageWorkflow } from "../triage/index.js";

const TIMEOUT_SECONDS = 8 * 60 * 60;

type StageName = "triage" | "spec-to-pr";
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
	startPrReview?: (input: PrReviewInput, idempotencyKey: string) => Promise<{ id: string }>;
}

async function autopilot(run: Run, input: TriageInput, deps: AutopilotDeps, ctx: GitHubTaskContext): Promise<Outcome<AutopilotData>> {
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
	const startPrReview = deps.startPrReview ?? ((reviewInput, key) => startTask(ctx, TASKS.prReview, reviewInput, key));

	const base = { repo: input.repo, installationId: input.installationId, actor: input.actor };
	await run.reportProgress("running Triage");
	const triage = record("triage", await runTriage({ ...base, issue: input.issue, commentId: input.commentId }));
	if (triage.state === "done" && (triage.outcome === "asked" || triage.outcome === "skipped")) {
		return { ...finish("waiting_for_answers", triage.summary), waiting: "reply" };
	}
	if (triage.state !== "done" || triage.data?.kind !== "spec") return stop("triage", triage);

	await run.reportProgress("implementing the spec");
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

	const { pr, headSha } = specToPr.data;
	await run.assertCurrent();
	try {
		await startPrReview({ ...base, pr, headSha }, `${run.traceId}:pr-review:${headSha}`);
	} catch (error) {
		console.error(JSON.stringify({ level: "warn", msg: "could not start PR Reviewer", pr, error: String(error) }));
		const summary = `opened draft PR #${pr}, but PR Reviewer couldn't start. Apply \`${config.labels.prReview}\` to the pull request to review it.`;
		return finish("review_not_started", summary, "failed");
	}
	return finish("pr_opened", `opened draft PR #${pr}; PR Reviewer is reviewing it on the pull request.`);
}

export const autopilotWorkflow = defineGitHubTask(
	{
		name: TASKS.autopilot,
		title: "Autopilot",
		input: AutopilotInput,
		thread: (input) => ({ kind: "issue", number: input.issue }),
		trigger: (input) => (input.commentId === undefined ? { label: config.labels.autopilot, number: input.issue } : undefined),
		replyTo: (input) => input.replyTo,
		timeoutSeconds: TIMEOUT_SECONDS,
	},
	autopilot,
);

export const runAutopilot = autopilotWorkflow.run;
