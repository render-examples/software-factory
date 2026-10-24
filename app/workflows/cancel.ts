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
	runId?: string;
	reason?: "permission_denied" | "nothing_running";
}

/** `/factory cancel`: stops the run the status comment names, if it's still active, and terminates its sandbox. */
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
	await emit({ ...event, type: "run.started", payload: { stage: TASKS.cancel, actor: input.actor } });

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
		if (!current || !(await stopRun(deps.runs ?? workflowRuns(), current.data, stop))) {
			await gh.createComment(input.number, `@${input.actor} no factory run is in progress here.`);
			return { cancelled: false, reason: "nothing_running" };
		}
		const { runId: cancelled, stage, title } = current.data;
		const summary = `cancelled by @${input.actor}.`;
		await finishStatus({ gh, number: input.number, runId: cancelled, task: stage, title: title ?? stage, state: "cancelled", summary });
		return { cancelled: true, runId: cancelled };
	})();

	await emit({ ...event, type: "run.finished", payload: { stage: TASKS.cancel, state: "done", ...result } });
	return result;
}

/** Not retried: a retry after a successful cancel would report that nothing is running. */
export const cancel = task(
	{ name: TASKS.cancel, timeoutSeconds: 120, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
	(ctx, raw: unknown) => cancelRun(ctx, raw),
);
