import { task } from "@renderinc/sdk/workflows";
import type { TaskContext } from "@renderinc/sdk/workflows";
import { config, requireRepo, TASKS } from "../config/index.js";
import { CancelInput } from "../contracts/tasks.js";
import { claimRun, emit } from "../events/index.js";
import { type GitHubClient, githubFor } from "../github/index.js";
import {
	cancelActiveRun,
	checkPermission,
	finishStatus,
	isRunActive,
	type RunControl,
	readStatus,
	type StatusGitHub,
	traceIds,
	workflowRuns,
} from "../runs/index.js";

export type CancelGitHub = StatusGitHub & Pick<GitHubClient, "getPermission">;

export interface CancelResult {
	cancelled: boolean;
	runId?: string;
	reason?: "permission-denied" | "nothing-running";
}

/** `/factory cancel`: cancels the run the status comment records, if it's still active. */
export async function cancelRun(
	ctx: Pick<TaskContext, "metadata">,
	raw: unknown,
	deps: { gh?: CancelGitHub; runs?: RunControl } = {},
): Promise<CancelResult> {
	const input = CancelInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId);
	const gh = deps.gh ?? githubFor(repo);
	const ids = traceIds(ctx);
	const traceId = ids.traceId;
	const runId = ids.runId ?? traceId;
	const event = { traceId, runId, repo: repo.fullName, subject: `${input.kind}#${input.number}` };
	await emit({ ...event, type: "run.started", payload: { stage: TASKS.cancel, actor: input.actor } });

	const result = await (async (): Promise<CancelResult> => {
		if (!(await checkPermission(gh, input.actor))) {
			await gh.createComment(
				input.number,
				`@${input.actor} needs \`${config.minimumPermission}\` permission on this repository to cancel factory runs.`,
			);
			return { cancelled: false, reason: "permission-denied" };
		}
		await claimRun({ ...event, stage: TASKS.cancel, actor: input.actor });
		const runs = deps.runs ?? workflowRuns();
		const current = await readStatus(gh, input.number);
		if (!current || !(await isRunActive(runs, current.data.runId))) {
			await gh.createComment(input.number, `@${input.actor} no factory run is in progress here.`);
			return { cancelled: false, reason: "nothing-running" };
		}
		await cancelActiveRun(runs, current.data.runId);
		await finishStatus({
			gh,
			number: input.number,
			runId: current.data.runId,
			stage: current.data.stage,
			state: "cancelled",
			summary: `cancelled by @${input.actor}.`,
		});
		return { cancelled: true, runId: current.data.runId };
	})();

	await emit({ ...event, type: "run.finished", payload: { stage: TASKS.cancel, state: "done", ...result } });
	return result;
}

/** Not retried: a retry after a successful cancel would report that nothing is running. */
export const cancel = task(
	{ name: TASKS.cancel, timeoutSeconds: 120, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
	(ctx, raw: unknown) => cancelRun(ctx, raw),
);
