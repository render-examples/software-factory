import { ClientError, Render } from "@renderinc/sdk";
import { TASKS } from "../config/index.js";
import {
	findMarkedComment,
	type GitHubClient,
	type IssueComment,
	type RunState,
	renderMarker,
	type StatusMarker,
} from "../github/index.js";

export type Phase = typeof TASKS.triage | typeof TASKS.specToPr | typeof TASKS.prReview;

export interface Subject {
	kind: "issue" | "pr";
	number: number;
}

export interface StatusLink {
	label: string;
	url: string;
}

/** On the issue or PR while a phase runs. */
export const WORKING_LABEL = "factory:working";

export type StatusGitHub = Pick<
	GitHubClient,
	"botLogin" | "listIssueComments" | "createComment" | "updateComment" | "ensureLabel" | "addLabels" | "removeLabel"
>;

/** The two Workflows calls latest-wins needs, injectable for tests. */
export interface RunControl {
	getTaskRun(taskRunId: string): Promise<{ status: string }>;
	cancelTaskRun(taskRunId: string): Promise<void>;
}

let defaultRuns: RunControl | undefined;

/** The Workflows API via the SDK. Reads RENDER_API_KEY. */
export function workflowRuns(): RunControl {
	if (!defaultRuns) {
		const workflows = new Render().workflows;
		defaultRuns = {
			getTaskRun: (id) => workflows.getTaskRun(id),
			cancelTaskRun: (id) => workflows.cancelTaskRun(id),
		};
	}
	return defaultRuns;
}

const PHASE_TITLES: Record<string, string> = {
	[TASKS.triage]: "Triage",
	[TASKS.specToPr]: "Spec-to-PR",
	[TASKS.prReview]: "PR Reviewer",
};

export function subjectName(subject: Subject): string {
	return `${subject.kind}#${subject.number}`;
}

/** The bot's status comment on the issue or PR, and the run it records. */
export async function readStatus(
	gh: StatusGitHub,
	number: number,
): Promise<{ comment: IssueComment; data: StatusMarker } | null> {
	return findMarkedComment(await gh.listIssueComments(number), "status", await gh.botLogin());
}

/** Whether a task run is pending or running. A confirmed 404 is finished; unknown state fails closed. */
export async function isRunActive(runs: RunControl, taskRunId: string): Promise<boolean> {
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
export async function cancelActiveRun(runs: RunControl, taskRunId: string): Promise<void> {
	try {
		await runs.cancelTaskRun(taskRunId);
	} catch (error) {
		if (await isRunActive(runs, taskRunId)) throw error;
	}
}

/**
 * Reconciles GitHub after a durable claim: cancels the run the status comment records if it is still active,
 * then records this run for people to see. Postgres claim order, not the comment, decides ownership.
 */
export async function takeOver(opts: {
	gh: StatusGitHub;
	subject: Subject;
	phase: Phase;
	runId: string;
	runs?: RunControl;
}): Promise<{ commentId: number; previousRunId: string | null; cancelledPrevious: boolean }> {
	const { gh, subject, phase, runId } = opts;
	const current = await readStatus(gh, subject.number);
	const previousRunId = current && current.data.runId !== runId ? current.data.runId : null;
	let cancelledPrevious = false;
	if (previousRunId) {
		const runs = opts.runs ?? workflowRuns();
		if (await isRunActive(runs, previousRunId)) {
			await cancelActiveRun(runs, previousRunId);
			cancelledPrevious = true;
		}
	}
	const body = statusBody({ phase, runId, state: "running" });
	const comment = current
		? await gh.updateComment(current.comment.id, body)
		: await gh.createComment(subject.number, body);
	await addWorkingLabel(gh, subject.number);
	return { commentId: comment.id, previousRunId, cancelledPrevious };
}

export interface StatusUpdate {
	gh: StatusGitHub;
	number: number;
	runId: string;
	phase: string;
	state: RunState;
	summary?: string;
	links?: StatusLink[];
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

function statusBody(s: { phase: string; runId: string; state: RunState; summary?: string; links?: StatusLink[] }): string {
	const title = PHASE_TITLES[s.phase] ?? s.phase;
	const detail = s.summary ? `: ${s.summary}` : "";
	const line = {
		running: `**${title}** is running (run \`${s.runId}\`)${detail}`,
		done: `**${title}** finished${detail}`,
		failed: `**${title}** failed${detail}`,
		cancelled: `**${title}** was cancelled${detail}`,
		rejected: `**${title}** did not run${detail}`,
	}[s.state];
	const links = (s.links ?? []).map((link) => `- [${link.label}](${link.url})`);
	const footer = s.state === "running" ? [] : [`<sub>run \`${s.runId}\`</sub>`];
	const marker = renderMarker("status", { runId: s.runId, phase: s.phase, state: s.state, at: new Date().toISOString() });
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
