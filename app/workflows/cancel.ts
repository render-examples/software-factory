import type { TaskContext } from "@renderinc/sdk/workflows";
import { task } from "@renderinc/sdk/workflows";
import { checkPermission, finishStatus, type RunControl, readStatus, type StatusGitHub, stopRun, traceIds, workflowRuns } from "../claims/index.js";
import { config, requireRepo, TASKS } from "../config/index.js";
import { emit } from "../events/index.js";
import { type GitHubClient, githubFor } from "../github/index.js";
import { CancelInput } from "../schemas/index.js";

type CancelGitHub = StatusGitHub & Pick<GitHubClient, "getPermission">;

interface CancelResult {
	cancelled: boolean;
	/** Root workflow run that was cancelled. */
	runId?: string;
	/** Child task that was active when the root was cancelled. */
	currentRunId?: string;
	reason?: "permission_denied" | "nothing_running" | "already_stopped";
}

/**
 * `/factory cancel`: stops the run the status comment names, if it's still active, and terminates its sandbox. A
 * comment that still says "running" for a run that already stopped (it was killed before it could finish) is
 * marked cancelled too, so the stale status and working label don't linger.
 */
export async function cancelRun(
	ctx: Pick<TaskContext, "metadata">,
	raw: unknown,
	deps: { gh?: CancelGitHub; runs?: RunControl } = {},
): Promise<CancelResult> {
	const input = CancelInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId);
	const gh = deps.gh ?? githubFor(repo);
	const { traceId, runId } = traceIds(ctx);
	const event = { traceId, runId, repo: repo.fullName, subject: `${input.kind}#${input.number}` };

	const result = await (async (): Promise<CancelResult> => {
		if (!(await checkPermission(gh, input.actor))) {
			await gh.createComment(
				input.number,
				`@${input.actor} needs \`${config.minimumPermission}\` permission on this repository to cancel factory runs.`,
			);
			return { cancelled: false, reason: "permission_denied" };
		}
		const current = await readStatus(gh, input.number);
		const stop = { repo: repo.fullName, subject: event.subject, by: runId, outcome: "cancelled" } as const;
		const active = current ? await stopRun(deps.runs ?? workflowRuns(), current.data, stop) : false;
		if (!current || (!active && current.data.state !== "running")) {
			await gh.createComment(input.number, `@${input.actor} no factory run is in progress here.`);
			return { cancelled: false, reason: "nothing_running" };
		}
		const { runId: currentRunId, traceId: stoppedTrace, rootStage, stage, title } = current.data;
		const rootRunId = stoppedTrace ?? currentRunId;
		const childWasRunning = current.data.state === "running";
		const displayedRunId = childWasRunning ? currentRunId : rootRunId;
		const displayedStage = childWasRunning ? stage : (rootStage ?? stage);
		const displayedTitle = childWasRunning ? (title ?? stage) : (rootStage ?? title ?? stage);
		const summary = active ? `cancelled by @${input.actor}.` : `cleared by @${input.actor}; the run had already stopped without finishing.`;
		await finishStatus(
			{
				gh,
				number: input.number,
				runId: displayedRunId,
				traceId: rootRunId,
				rootStage,
				task: displayedStage,
				title: displayedTitle,
				state: "cancelled",
				summary,
			},
			{ rootFinished: true },
		);
		const child = childWasRunning && rootRunId !== currentRunId ? { currentRunId } : {};
		return active ? { cancelled: true, runId: rootRunId, ...child } : { cancelled: false, runId: rootRunId, ...child, reason: "already_stopped" };
	})();

	emit({ ...event, type: "run.finished", payload: { stage: TASKS.cancel, state: "done", ...result } });
	return result;
}

/** Not retried: a retry after a successful cancel would report that nothing is running. */
export const cancel = task(
	{ name: TASKS.cancel, timeoutSeconds: 120, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
	(ctx, raw: unknown) => cancelRun(ctx, raw),
);
