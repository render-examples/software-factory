import { type ZodType, z } from "zod";
import { config, resolveRepo, TASKS, type TaskName } from "../config/index.js";
import { CancelInput, PrReviewInput, RefreshSnapshotInput, SpecToPrInput, TriageInput } from "../schemas/tasks.js";

export type Route =
	| {
			kind: "start";
			task: TaskName;
			/** Already validated with the task's input schema. */
			input: object;
			idempotencyKey: string;
			/** "issue#12" or "pr#34", for the delivery event. */
			subject?: string;
	  }
	| { kind: "ignore"; reason: string }
	/** An authenticated delivery that maps to a task but not to a valid input for it: a bug worth a failed delivery. */
	| { kind: "invalid"; task: TaskName; reason: string; subject?: string };

const Envelope = z.object({
	action: z.string().optional(),
	repository: z.object({ full_name: z.string() }).optional(),
	installation: z.object({ id: z.number().int() }).optional(),
	sender: z.object({ login: z.string(), type: z.string() }).optional(),
});

const Label = z.object({ name: z.string() });

const Issue = z.object({
	number: z.number().int(),
	updated_at: z.string().optional(),
	labels: z.array(Label).default([]),
	pull_request: z.unknown().optional(),
});

const IssuesEvent = z.object({ label: Label.optional(), issue: Issue });

const PullRequestEvent = z.object({
	label: Label.optional(),
	pull_request: z.object({
		number: z.number().int(),
		state: z.string(),
		head: z.object({ sha: z.string() }),
	}),
});

const IssueCommentEvent = z.object({
	issue: Issue,
	comment: z.object({ id: z.number().int(), body: z.string().nullable().default("") }),
});

const PushEvent = z.object({
	ref: z.string(),
	after: z.string(),
	deleted: z.boolean().default(false),
});

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);

const ignore = (reason: string): Route => ({ kind: "ignore", reason });
const isPullRequest = (issue: z.infer<typeof Issue>) => issue.pull_request !== undefined && issue.pull_request !== null;

/** Maps one GitHub delivery to the task it starts, or why it starts nothing. No I/O. */
export function route(event: string, payload: unknown, deliveryId: string): Route {
	if (event === "ping") return ignore("ping");

	const envelope = Envelope.safeParse(payload);
	if (!envelope.success) return ignore("malformed payload");
	const { action, repository, installation, sender } = envelope.data;
	if (!repository) return ignore("no repository");
	if (!installation) return ignore("no installation");
	const repo = resolveRepo(repository.full_name, installation.id);
	if (!repo) return ignore("unconfigured repo");
	if (event !== "push" && sender?.type === "Bot") return ignore("bot sender");

	const base = { repo: repo.fullName, installationId: repo.installationId };
	const actor = sender?.login ?? "";
	const start = (task: TaskName, schema: ZodType, input: Record<string, unknown>, subject?: string, idempotencyKey = deliveryId): Route => {
		const parsed = schema.safeParse({ ...base, ...input });
		if (!parsed.success) return { kind: "invalid", task, reason: parsed.error.message, ...(subject ? { subject } : {}) };
		return { kind: "start", task, input: parsed.data as object, idempotencyKey, ...(subject ? { subject } : {}) };
	};

	switch (event) {
		case "issues": {
			if (action !== "labeled") return ignore("unhandled action");
			const parsed = IssuesEvent.safeParse(payload);
			if (!parsed.success) return ignore("malformed payload");
			const { label, issue } = parsed.data;
			if (isPullRequest(issue)) return ignore("pull request");
			const subject = `issue#${issue.number}`;
			if (label?.name === config.labels.triage) {
				return start(TASKS.triage, TriageInput, { issue: issue.number, actor }, subject);
			}
			if (label?.name === config.labels.specApproved) {
				// GitHub bumps updated_at when the label is applied.
				return start(TASKS.specToPr, SpecToPrInput, { issue: issue.number, actor, labeledAt: issue.updated_at }, subject);
			}
			return ignore("unhandled label");
		}

		case "pull_request": {
			if (action !== "labeled") return ignore("unhandled action");
			const parsed = PullRequestEvent.safeParse(payload);
			if (!parsed.success) return ignore("malformed payload");
			const { label, pull_request: pr } = parsed.data;
			if (label?.name !== config.labels.prReview) return ignore("unhandled label");
			if (pr.state !== "open") return ignore("pull request not open");
			return start(TASKS.prReview, PrReviewInput, { pr: pr.number, headSha: pr.head.sha, actor }, `pr#${pr.number}`);
		}

		case "issue_comment": {
			if (action !== "created") return ignore("unhandled action");
			const parsed = IssueCommentEvent.safeParse(payload);
			if (!parsed.success) return ignore("malformed payload");
			const { issue, comment } = parsed.data;
			const isPr = isPullRequest(issue);
			const subject = `${isPr ? "pr" : "issue"}#${issue.number}`;
			const firstLine = (comment.body ?? "").split(/\r?\n/, 1)[0]?.trim();
			if (firstLine === `${config.commandPrefix} cancel`) {
				return start(TASKS.cancel, CancelInput, { number: issue.number, kind: isPr ? "pr" : "issue", actor }, subject);
			}
			if (isPr) return ignore("comment on pull request");
			if (!issue.labels.some((l) => l.name === config.labels.triage)) return ignore("issue not in triage");
			return start(TASKS.triage, TriageInput, { issue: issue.number, actor, commentId: comment.id }, subject);
		}

		case "push": {
			const parsed = PushEvent.safeParse(payload);
			if (!parsed.success) return ignore("malformed payload");
			const { ref, after, deleted } = parsed.data;
			if (ref !== `refs/heads/${repo.config.baseBranch}`) return ignore("not base branch");
			if (deleted) return ignore("branch deleted");
			if (!SHA.test(after) || after === ZERO_SHA) return ignore("invalid sha");
			return start(TASKS.refreshSnapshot, RefreshSnapshotInput, { sha: after }, undefined, `${repo.fullName}@${after}`);
		}

		default:
			return ignore("unhandled event");
	}
}
