import type { TaskContext } from "@renderinc/sdk/workflows";
import { task } from "@renderinc/sdk/workflows";
import {
	checkPermission,
	type RunControl,
	readClaim,
	release,
	runEvent,
	type StatusGitHub,
	stopRun,
	syncStatus,
	traceIds,
	workflowRuns,
} from "../claims/index.js";
import { config, requireRepo, TASKS } from "../config/index.js";
import { append, type Db, type NewEvent, workflowsDb } from "../db/index.js";
import { runFinished, runRejected, runStarted } from "../events/index.js";
import { type GitHubClient, githubFor } from "../github/index.js";
import { CancelInput } from "../schemas/index.js";
import { githubThread, type ThreadKey } from "../threads/index.js";

type CancelGitHub = StatusGitHub & Pick<GitHubClient, "getPermission">;

interface CancelResult {
	cancelled: boolean;
	/** Root workflow run that was cancelled. */
	runId?: string;
	/** Child task that was active when the root was cancelled. */
	currentRunId?: string;
	reason?: "permission_denied" | "nothing_running" | "already_stopped";
}

/** `/factory cancel`: stops the trace that holds the claim on the issue or PR, releases the claim, and updates the status comment. */
export async function cancelRun(
	ctx: Pick<TaskContext, "metadata">,
	raw: unknown,
	deps: { gh?: CancelGitHub; runs?: RunControl; db?: Db } = {},
): Promise<CancelResult> {
	const input = CancelInput.parse(raw);
	const repo = requireRepo(input.repo, input.installationId);
	const gh = deps.gh ?? githubFor(repo);
	const db = deps.db ?? workflowsDb();
	const { traceId, runId } = traceIds(ctx);
	const { actor } = input;
	const thread = { kind: input.kind, number: input.number };
	const key = githubThread(repo.fullName, thread);
	const startedAt = Date.now();
	const record = (event: NewEvent) => db.withTx((tx) => append(tx, event));

	await record(runEvent(runStarted, runId, key, { trace_id: traceId, task: TASKS.cancel, title: "Cancel", actor, mode: "replace" }));
	if (!(await checkPermission(gh, actor))) {
		const reason = `@${actor} needs \`${config.minimumPermission}\` permission on this repository to cancel factory runs.`;
		await gh.createComment(input.number, reason);
		await record(runEvent(runRejected, runId, key, { actor, reason }));
		return { cancelled: false, reason: "permission_denied" };
	}

	const result = await cancelClaim(db, deps.runs ?? workflowRuns(), key, runId, actor);
	await syncStatus(db, gh, repo.fullName, thread);
	if (result.reason === "nothing_running") await gh.createComment(input.number, `@${actor} no factory run is in progress here.`);
	const summary = result.runId ? `${result.cancelled ? "cancelled" : "cleared"} \`${result.runId}\`.` : "no factory run was in progress.";
	await record(
		runEvent(runFinished, runId, key, {
			state: "done",
			outcome: result.reason ?? "cancelled",
			summary,
			links: [],
			duration_ms: Date.now() - startedAt,
		}),
	);
	return result;
}

/**
 * Stops the trace holding the claim and releases it. Runs still recorded as running after their trace stopped
 * (Render killed it before it could finish) are closed as cancelled too, so their status doesn't linger.
 */
async function cancelClaim(db: Db, runs: RunControl, thread: ThreadKey, by: string, actor: string): Promise<CancelResult> {
	const claim = await readClaim(db, thread);
	if (!claim?.held) return { cancelled: false, reason: "nothing_running" };
	const summary = (active: boolean) => (active ? `cancelled by @${actor}.` : `cleared by @${actor}; the run had already stopped without finishing.`);
	const { active, stopped } = await stopRun(db, runs, claim.traceId, { by, outcome: "cancelled", summary });
	await release(db, thread, claim.traceId, by, "cancelled");
	if (!active && !stopped.length) return { cancelled: false, reason: "nothing_running" };
	const child = claim.runId !== claim.traceId && stopped.includes(claim.runId) ? { currentRunId: claim.runId } : {};
	return active
		? { cancelled: true, runId: claim.traceId, ...child }
		: { cancelled: false, runId: claim.traceId, ...child, reason: "already_stopped" };
}

/** Not retried: a retry after a successful cancel would report that nothing is running. */
export const cancel = task(
	{ name: TASKS.cancel, timeoutSeconds: 120, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
	(ctx, raw: unknown) => cancelRun(ctx, raw),
);
