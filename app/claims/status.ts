import { ClientError, Render } from "@renderinc/sdk";
import { emit } from "../events/index.js";
import { findMarkedComment, type GitHubClient, type IssueComment, type RunState, renderMarker, type StatusMarker } from "../github/index.js";
import { sandboxClient } from "../sandbox/index.js";

export interface Subject {
	kind: "issue" | "pr";
	number: number;
}

export interface StatusLink {
	label: string;
	url: string;
}

/** On the issue or PR while a claiming task runs. */
export const WORKING_LABEL = "factory:working";

export type StatusGitHub = Pick<
	GitHubClient,
	"botLogin" | "listIssueComments" | "createComment" | "updateComment" | "ensureLabel" | "addLabels" | "removeLabel"
>;

/** The Render calls that stop a previous run, injectable for tests. */
export interface RunControl {
	getTaskRun(taskRunId: string): Promise<{ status: string }>;
	cancelTaskRun(taskRunId: string): Promise<void>;
	/** Idempotent: a sandbox that no longer exists counts as terminated. */
	terminateSandbox(sandboxId: string): Promise<void>;
}

let defaultRuns: RunControl | undefined;

/** The Workflows and Sandbox APIs via the SDK. Reads RENDER_API_KEY and RENDER_WORKSPACE_ID. */
export function workflowRuns(): RunControl {
	if (!defaultRuns) {
		const workflows = new Render().workflows;
		defaultRuns = {
			getTaskRun: (id) => workflows.getTaskRun(id),
			cancelTaskRun: (id) => workflows.cancelTaskRun(id),
			terminateSandbox: (id) => sandboxClient().terminate(id),
		};
	}
	return defaultRuns;
}

export function subjectName(subject: Subject): string {
	return `${subject.kind}#${subject.number}`;
}

/** The bot's status comment on the issue or PR, and the run it records. */
export async function readStatus(gh: StatusGitHub, number: number): Promise<{ comment: IssueComment; data: StatusMarker } | null> {
	return findMarkedComment(await gh.listIssueComments(number), "status", await gh.botLogin());
}

/** Who stops a run and why, for the `run.finished` event recorded on the stopped run's behalf. */
export interface StopContext {
	/** "owner/name" */
	repo: string;
	/** "issue#12" or "pr#34" */
	subject: string;
	/** The task run doing the stopping. */
	by: string;
	outcome: "superseded" | "cancelled";
}

/**
 * Stops the run a status marker records: cancels it if it's still active, then terminates the sandbox it recorded.
 * Render kills a cancelled task without running its `finally`, so the sandbox would otherwise live until its
 * timeout, and the run never records how it ended; this records `run.finished` for it. Returns whether the run
 * was still active.
 */
export async function stopRun(runs: RunControl, status: StatusMarker, context: StopContext): Promise<boolean> {
	const active = await isRunActive(runs, status.runId);
	if (active) {
		await cancelActiveRun(runs, status.runId);
		const { repo, subject, by, outcome } = context;
		// Claiming tasks are started by the gateway, so each is its own root task run and its run ID is its trace ID.
		const payload = { stage: status.stage, state: "cancelled", outcome, stoppedBy: by };
		emit({ traceId: status.runId, runId: status.runId, repo, subject, type: "run.finished", payload });
	}
	if (status.sandboxId) {
		const { sandboxId } = status;
		await runs.terminateSandbox(sandboxId).catch((error) => warn("could not terminate the stopped run's sandbox", error, { sandboxId }));
	}
	return active;
}

/** Whether a task run is pending or running. A confirmed 404 is finished; unknown state fails closed. */
async function isRunActive(runs: RunControl, taskRunId: string): Promise<boolean> {
	try {
		const { status } = await runs.getTaskRun(taskRunId);
		return status === "pending" || status === "running";
	} catch (error) {
		if (error instanceof ClientError && error.statusCode === 404) return false;
		warn("could not read task run; refusing to assume it finished", error, { taskRunId });
		throw error;
	}
}

/** Cancels a run. A cancel that fails because the run just finished is fine; one that leaves it running throws. */
async function cancelActiveRun(runs: RunControl, taskRunId: string): Promise<void> {
	try {
		await runs.cancelTaskRun(taskRunId);
	} catch (error) {
		if (await isRunActive(runs, taskRunId)) throw error;
	}
}

/**
 * Claims the issue or PR for this run: stops the run the status comment names, then rewrites the comment to name
 * this run. The comment is the claim, so the caller must confirm it still names this run before relying on it.
 */
export async function takeOver(opts: {
	gh: StatusGitHub;
	/** "owner/name" */
	repo: string;
	subject: Subject;
	task: string;
	title: string;
	runId: string;
	runs?: RunControl;
}): Promise<{ commentId: number; previousRunId: string | null; cancelledPrevious: boolean }> {
	const { gh, repo, subject, task, title, runId } = opts;
	const current = await readStatus(gh, subject.number);
	const previous = current && current.data.runId !== runId ? current.data : null;
	const stop = { repo, subject: subjectName(subject), by: runId, outcome: "superseded" } as const;
	const cancelledPrevious = previous ? await stopRun(opts.runs ?? workflowRuns(), previous, stop) : false;
	const body = statusBody({ task, title, runId, state: "running" });
	const comment = current ? await gh.updateComment(current.comment.id, body) : await gh.createComment(subject.number, body);
	await addWorkingLabel(gh, subject.number);
	return { commentId: comment.id, previousRunId: previous?.runId ?? null, cancelledPrevious };
}

export interface StatusUpdate {
	gh: StatusGitHub;
	number: number;
	runId: string;
	/** The task's registered name. */
	task: string;
	/** The task's name in the comment, such as "PR Reviewer". */
	title: string;
	state: RunState;
	summary?: string;
	links?: StatusLink[];
	/** The run's open sandbox, recorded while it's running so a run that stops this one can terminate it. */
	sandboxId?: string;
}

/**
 * Updates the status comment. Never overwrites a newer run's status, and a rejected trigger never overwrites a
 * real run's record. Returns whether it wrote.
 */
export async function setStatus(update: StatusUpdate): Promise<boolean> {
	const current = await readStatus(update.gh, update.number);
	const body = statusBody(update);
	if (!current) {
		await update.gh.createComment(update.number, body);
		return true;
	}
	const ours = current.data.runId === update.runId;
	if (!ours && (current.data.state === "running" || (update.state === "rejected" && current.data.state !== "rejected"))) {
		return false;
	}
	await update.gh.updateComment(current.comment.id, body);
	return true;
}

/** Records a terminal state and removes the working label. */
export async function finishStatus(update: StatusUpdate & { state: Exclude<RunState, "running"> }): Promise<boolean> {
	const wrote = await setStatus(update);
	if (wrote) await removeWorkingLabel(update.gh, update.number);
	return wrote;
}

function statusBody(s: Omit<StatusUpdate, "gh" | "number">): string {
	const detail = s.summary ? `: ${s.summary}` : "";
	const line = {
		running: `**${s.title}** is running (run \`${s.runId}\`)${detail}`,
		done: `**${s.title}** finished${detail}`,
		failed: `**${s.title}** failed${detail}`,
		cancelled: `**${s.title}** was cancelled${detail}`,
		rejected: `**${s.title}** did not run${detail}`,
	}[s.state];
	const links = (s.links ?? []).map((link) => `- [${link.label}](${link.url})`);
	const footer = s.state === "running" ? [] : [`<sub>run \`${s.runId}\`</sub>`];
	const sandboxId = s.state === "running" ? s.sandboxId : undefined;
	const marker = renderMarker("status", { runId: s.runId, stage: s.task, title: s.title, state: s.state, at: new Date().toISOString(), sandboxId });
	return [line, ...(links.length ? ["", ...links] : []), ...(footer.length ? ["", ...footer] : []), "", marker].join("\n");
}

/** Labels are cosmetic: failures are logged, never fail a run. */
async function addWorkingLabel(gh: StatusGitHub, number: number): Promise<void> {
	try {
		await gh.ensureLabel(WORKING_LABEL, "fbca04", "software-factory is working on this");
		await gh.addLabels(number, [WORKING_LABEL]);
	} catch (error) {
		warn("could not add working label", error, { number });
	}
}

async function removeWorkingLabel(gh: StatusGitHub, number: number): Promise<void> {
	try {
		await gh.removeLabel(number, WORKING_LABEL);
	} catch (error) {
		warn("could not remove working label", error, { number });
	}
}

function warn(msg: string, error: unknown, fields: Record<string, unknown>): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ level: "warn", msg, ...fields, error: message }));
}
