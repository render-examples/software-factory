import type { TaskContext } from "@renderinc/sdk/workflows";
import { AgentError, type AgentErrorCode, type RunAgentOptions } from "../agents/index.js";
import { config, type RepoContext } from "../config/index.js";
import { emit } from "../events/index.js";
import { type GitHubClient, githubFor, type RunState } from "../github/index.js";
import { checkPermission } from "./permission.js";
import {
	finishStatus,
	type RunControl,
	readStatus,
	type StatusLink,
	type StatusUpdate,
	type Subject,
	setStatus,
	subjectName,
	takeOver,
} from "./status.js";
import { traceIds } from "./trace.js";

/** What the work gets: this task run's identity and its claim on the issue or PR. */
export interface Claim {
	readonly gh: GitHubClient;
	readonly repo: RepoContext;
	readonly subject: Subject;
	readonly traceId: string;
	readonly runId: string;
	/** Fails when a newer run has claimed this issue or PR. Call before durable writes. */
	checkpoint(): Promise<void>;
	/** Checks the claim, then shows progress in the status comment. */
	progress(summary: string): Promise<void>;
	/** Records an opened sandbox in the status comment, so a run that stops this one can terminate it. Call first thing. */
	recordSandbox(sandbox: RunAgentOptions["sandbox"]): Promise<void>;
	/** runAgent options for `sandbox`, so the agent's events carry this run's trace. */
	agentOptions(sandbox: RunAgentOptions["sandbox"]): RunAgentOptions;
}

/** How the work ended. `summary` is shown on GitHub, so it must be safe to publish. */
export interface Outcome {
	outcome: string;
	summary: string;
	state?: "done" | "failed";
	links?: StatusLink[];
}

/** What a claiming task returns to Render Workflows. */
export interface TaskResult {
	state: Exclude<RunState, "running">;
	outcome: string;
	summary: string;
	traceId: string;
	runId: string;
}

/** An expected failure: its message is shown on GitHub and the task succeeds. Anything else fails the task. */
export class ExpectedFailure extends Error {
	constructor(
		message: string,
		readonly outcome = "failed",
	) {
		super(message);
		this.name = "ExpectedFailure";
	}
}

export interface ClaimOptions {
	repo: RepoContext;
	subject: Subject;
	/** The task's registered name; recorded in the status marker and in events. */
	task: string;
	/** The task's name in the status comment, such as "PR Reviewer". */
	title: string;
	actor: string;
	gh?: GitHubClient;
	runs?: RunControl;
}

/**
 * Runs `work` while this task run claims the issue or PR. The status comment is the claim: the run it names holds
 * it. withClaim checks the actor's permission, stops the previous run and takes over the comment, keeps it
 * current, and records how the run ended.
 */
export async function withClaim(
	ctx: Pick<TaskContext, "metadata">,
	opts: ClaimOptions,
	work: (claim: Claim) => Promise<Outcome>,
): Promise<TaskResult> {
	const run = new ClaimedRun(ctx, opts);
	await run.recordStart();
	try {
		if (!(await run.authorized())) return await run.reject();
		await run.acquire();
		return await run.finish(await work(run));
	} catch (error) {
		return await run.fail(error);
	}
}

/** Thrown once the status comment names another run. */
class Superseded extends Error {}

/** Ways an agent stops that come from the model or its limits. Any other agent error is the platform's and fails the task. */
const AGENT_STOPS: Partial<Record<AgentErrorCode, string>> = {
	max_turns: "ran out of turns",
	timeout: "timed out",
	no_submission: "ended without submitting a result",
	invalid_submission: "submitted an invalid result",
	output_invalid: "submitted an invalid result",
};

/** The lifecycle behind a Claim. Only withClaim calls the methods beyond the Claim interface. */
class ClaimedRun implements Claim {
	readonly gh: GitHubClient;
	readonly repo: RepoContext;
	readonly subject: Subject;
	readonly traceId: string;
	readonly runId: string;
	readonly #opts: ClaimOptions;
	readonly #event: { traceId: string; runId: string; repo: string; subject: string };
	readonly #startedAt = Date.now();
	#summary = "";
	#sandboxId: string | undefined;

	constructor(ctx: Pick<TaskContext, "metadata">, opts: ClaimOptions) {
		({ traceId: this.traceId, runId: this.runId } = traceIds(ctx));
		this.repo = opts.repo;
		this.subject = opts.subject;
		this.gh = opts.gh ?? githubFor(opts.repo);
		this.#opts = opts;
		this.#event = { traceId: this.traceId, runId: this.runId, repo: opts.repo.fullName, subject: subjectName(opts.subject) };
	}

	async checkpoint(): Promise<void> {
		if (!(await this.#holdsClaim())) throw new Superseded();
	}

	async progress(summary: string): Promise<void> {
		this.#summary = summary;
		await this.checkpoint();
		// A newer run can take over between the check and the write; setStatus refuses to overwrite its running status.
		if (!(await setStatus(this.#status("running", summary)))) throw new Superseded();
	}

	async recordSandbox(sandbox: RunAgentOptions["sandbox"]): Promise<void> {
		this.#sandboxId = sandbox.id;
		await this.progress(this.#summary);
	}

	agentOptions(sandbox: RunAgentOptions["sandbox"]): RunAgentOptions {
		return { sandbox, ...this.#event };
	}

	async recordStart(): Promise<void> {
		await emit({ ...this.#event, type: "run.started", payload: { stage: this.#opts.task, actor: this.#opts.actor } });
	}

	authorized(): Promise<boolean> {
		return checkPermission(this.gh, this.#opts.actor);
	}

	/** A rejected trigger never held the claim; setStatus keeps its record from replacing a real run's. */
	async reject(): Promise<TaskResult> {
		const summary = `@${this.#opts.actor} needs \`${config.minimumPermission}\` permission on this repository to start it.`;
		await finishStatus(this.#status("rejected", summary));
		return await this.#record("rejected", "permission_denied", summary);
	}

	/** Stops the previous run and rewrites the status comment to name this one, then confirms no other run's write landed after it. */
	async acquire(): Promise<void> {
		const { task, title, runs } = this.#opts;
		await takeOver({ gh: this.gh, repo: this.repo.fullName, subject: this.subject, task, title, runId: this.runId, runs });
		await this.checkpoint();
	}

	async finish(outcome: Outcome): Promise<TaskResult> {
		const state = outcome.state ?? "done";
		if (!(await this.#publish(state, outcome.summary, outcome.links))) throw new Superseded();
		return await this.#record(state, outcome.outcome, outcome.summary);
	}

	/**
	 * A superseded run and an expected failure end the task normally. Anything else is reported on GitHub without
	 * its message, which can hold secrets or repository output, and rethrown so the task fails.
	 */
	async fail(error: unknown): Promise<TaskResult> {
		if (error instanceof Superseded) return await this.#record("cancelled", "superseded", "a newer run took over.");
		if (error instanceof ExpectedFailure) {
			await this.#publish("failed", error.message);
			return await this.#record("failed", error.outcome, error.message);
		}
		if (error instanceof AgentError && AGENT_STOPS[error.code]) {
			// The agent's own message can quote repository output, so it goes to the event, not GitHub.
			const summary = `the ${error.agentId} agent ${AGENT_STOPS[error.code]}.`;
			await this.#publish("failed", summary);
			return await this.#record("failed", "agent_stopped", summary, { error: error.message.slice(0, 500) });
		}
		const summary = `something went wrong. Run \`${this.runId}\` has the details in the Render Dashboard.`;
		await this.#publish("failed", summary).catch(() => undefined);
		const message = error instanceof Error ? error.message : String(error);
		await this.#record("failed", "error", summary, { error: message.slice(0, 500) });
		throw error;
	}

	async #holdsClaim(): Promise<boolean> {
		return (await readStatus(this.gh, this.subject.number))?.data.runId === this.runId;
	}

	#status<S extends StatusUpdate["state"]>(state: S, summary: string, links?: StatusLink[]): StatusUpdate & { state: S } {
		const { task, title } = this.#opts;
		return { gh: this.gh, number: this.subject.number, runId: this.runId, task, title, state, summary, links, sandboxId: this.#sandboxId };
	}

	/** Writes a final state while this run still holds the claim; false once another run's status is showing. */
	async #publish(state: TaskResult["state"], summary: string, links?: StatusLink[]): Promise<boolean> {
		if (!(await this.#holdsClaim())) return false;
		return await finishStatus(this.#status(state, summary, links));
	}

	async #record(state: TaskResult["state"], outcome: string, summary: string, extra: Record<string, unknown> = {}): Promise<TaskResult> {
		const durationMs = Date.now() - this.#startedAt;
		await emit({ ...this.#event, type: "run.finished", payload: { stage: this.#opts.task, state, outcome, durationMs, ...extra } });
		return { state, outcome, summary, traceId: this.traceId, runId: this.runId };
	}
}
