import { z } from "zod";

/**
 * One type of event in the log. Bump `version` whenever the payload schema changes; readers handle every version
 * still in the log. Bound every string and array, and give no schema a free-form field for keys or tokens.
 */
export interface EventSpec<S extends z.ZodType = z.ZodType> {
	readonly type: string;
	readonly version: number;
	readonly payload: S;
}

/** The `subject` of every event about an issue or pull request: "owner/name#issue-12" or "owner/name#pr-34". */
export function subjectKey(repo: string, subject: { kind: "issue" | "pr"; number: number }): string {
	return `${repo}#${subject.kind}-${subject.number}`;
}

/** Every event type the factory writes is declared in this file with `defineEvent`. */
export function defineEvent<S extends z.ZodType>(type: string, version: number, payload: S): EventSpec<S> {
	return { type, version, payload };
}

// Run coordination (plan 02)

const id = z.string().min(1).max(200);
const name = z.string().min(1).max(100);
/** Shown on GitHub, so already safe to publish. */
const summary = z.string().max(16_000);
const finalState = z.enum(["done", "failed", "cancelled"]);

/** Stream `delivery:<id>`: an authenticated webhook delivery and the task it started or why it started none. */
export const deliveryReceived = defineEvent(
	"delivery.received",
	1,
	z.strictObject({ event: name, repo: id.optional(), task: name.optional(), ignored: z.string().max(200).optional() }),
);

/** Stream `run:<task_run_id>` for the rest of this block. `trace_id` is the root task run. */
export const runStarted = defineEvent(
	"run.started",
	1,
	z.strictObject({ trace_id: id, task: name, title: name, actor: name, mode: z.enum(["replace", "continue"]) }),
);

/** The actor lacked the permission to start the run, which never claimed its subject. */
export const runRejected = defineEvent("run.rejected", 1, z.strictObject({ actor: name, reason: summary }));

export const runProgress = defineEvent("run.progress", 1, z.strictObject({ summary }));

export const runSandboxAttached = defineEvent("run.sandbox_attached", 1, z.strictObject({ sandbox_id: id }));

/** Another run stopped this one; `by` is that run, and `active` whether Render still had this one's trace running. */
export const runStopped = defineEvent(
	"run.stopped",
	1,
	z.strictObject({ by: id, outcome: z.enum(["superseded", "cancelled"]), active: z.boolean(), summary }),
);

export const runFinished = defineEvent(
	"run.finished",
	1,
	z.strictObject({
		state: finalState,
		outcome: name,
		summary,
		links: z.array(z.strictObject({ label: z.string().max(200), url: z.string().max(2000) })).max(20),
		duration_ms: z.number().int().nonnegative(),
	}),
);

/** Stream `subject:<subject>`; its version fences claims. `run_id` is the trace's current task run. */
export const claimAcquired = defineEvent(
	"claim.acquired",
	1,
	z.strictObject({ trace_id: id, run_id: id, previous_trace_id: id.nullable(), previous_run_id: id.nullable() }),
);

export const claimReleased = defineEvent("claim.released", 1, z.strictObject({ trace_id: id, state: finalState }));
