import { type ZodType, z } from "zod";
import { config, resolveRepo, TASKS, type TaskName } from "../config/index.js";
import type { NewEvent } from "../db/index.js";
import { deliveryReceived } from "../events/index.js";
import { AutopilotInput, CancelInput, PrReviewInput, RefreshSnapshotInput, SpecToPrInput, TriageInput } from "../schemas/index.js";
import { type GitHubThread, githubThread, type ThreadKey } from "../threads/index.js";
import { SHA } from "../util/index.js";

export type Decision =
	| {
			kind: "start";
			task: TaskName;
			input: { repo: string };
			idempotencyKey: string;
			thread?: ThreadKey;
	  }
	| { kind: "ignore"; reason: string }
	| { kind: "invalid"; task: TaskName; reason: string; thread?: ThreadKey };

export interface ThreadState {
	waiting: string | null;
}

export type Route = Decision | { kind: "lookup"; thread: ThreadKey; decide(state: ThreadState): Decision };

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

const ZERO_SHA = "0".repeat(40);

const ignore = (reason: string): Decision => ({ kind: "ignore", reason });
const isPullRequest = (issue: z.infer<typeof Issue>) => issue.pull_request !== undefined && issue.pull_request !== null;

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
	const on = (thread: GitHubThread) => githubThread(repo.fullName, thread);
	const start = (task: TaskName, schema: ZodType, input: Record<string, unknown>, at?: GitHubThread, idempotencyKey = deliveryId): Decision => {
		const thread = at && on(at);
		const parsed = schema.safeParse({ ...base, ...input });
		if (!parsed.success) return { kind: "invalid", task, reason: parsed.error.message, thread };
		return { kind: "start", task, input: parsed.data as { repo: string }, idempotencyKey, thread };
	};

	switch (event) {
		case "issues": {
			if (action !== "labeled") return ignore("unhandled action");
			const parsed = IssuesEvent.safeParse(payload);
			if (!parsed.success) return ignore("malformed payload");
			const { label, issue } = parsed.data;
			if (isPullRequest(issue)) return ignore("pull request");
			const thread = { kind: "issue", number: issue.number } as const;
			if (label?.name === config.labels.triage) {
				return start(TASKS.triage, TriageInput, { issue: issue.number, actor }, thread);
			}
			if (label?.name === config.labels.specApproved) {
				return start(TASKS.specToPr, SpecToPrInput, { issue: issue.number, actor, approval: { kind: "label", labeledAt: issue.updated_at } }, thread);
			}
			if (label?.name === config.labels.autopilot) {
				return start(TASKS.autopilot, AutopilotInput, { issue: issue.number, actor }, thread);
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
			return start(TASKS.prReview, PrReviewInput, { pr: pr.number, headSha: pr.head.sha, actor }, { kind: "pr", number: pr.number });
		}

		case "issue_comment": {
			if (action !== "created") return ignore("unhandled action");
			const parsed = IssueCommentEvent.safeParse(payload);
			if (!parsed.success) return ignore("malformed payload");
			const { issue, comment } = parsed.data;
			const firstLine = (comment.body ?? "").split(/\r?\n/, 1)[0]?.trim();
			if (firstLine === `${config.commandPrefix} cancel`) {
				const thread = { kind: isPullRequest(issue) ? "pr" : "issue", number: issue.number } as const;
				return start(TASKS.cancel, CancelInput, { ...thread, actor }, thread);
			}
			if (isPullRequest(issue)) return ignore("comment on pull request");
			const thread = { kind: "issue", number: issue.number } as const;
			return {
				kind: "lookup",
				thread: on(thread),
				decide: ({ waiting }) => {
					const input = { issue: issue.number, actor, commentId: comment.id };
					if (waiting === TASKS.triage) return start(TASKS.triage, TriageInput, input, thread);
					if (waiting === TASKS.autopilot) return start(TASKS.autopilot, AutopilotInput, input, thread);
					return ignore("thread is not waiting for a reply");
				},
			};
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

export function deliveryEvent(deliveryId: string, event: string, decision: Decision): NewEvent<typeof deliveryReceived.payload> {
	const payload =
		decision.kind === "ignore"
			? { event, ignored: decision.reason }
			: decision.kind === "invalid"
				? { event, task: decision.task, ignored: "invalid task input" }
				: { event, repo: decision.input.repo, task: decision.task };
	const thread = decision.kind === "ignore" ? undefined : decision.thread;
	const stream = `delivery:github:${deliveryId}`;
	return { type: deliveryReceived, stream, thread, source: "github", payload, idempotencyKey: stream };
}
