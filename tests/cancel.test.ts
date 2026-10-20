import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryEvent, RunClaimInput } from "../app/events/index.js";

const events: FactoryEvent[] = [];
const claims: RunClaimInput[] = [];
vi.mock("../app/events/index.js", () => ({
	emit: async (event: FactoryEvent) => {
		events.push(event);
	},
	claimRun: async (input: RunClaimInput) => {
		claims.push(input);
		return { id: "1", ...input };
	},
	isCurrentRun: async () => true,
}));

const { parseMarker, renderMarker } = await import("../app/github/index.js");
const { WORKING_LABEL } = await import("../app/phases/index.js");
const { cancelRun } = await import("../app/workflows/cancel.js");
type IssueComment = import("../app/github/index.js").IssueComment;
type Permission = import("../app/github/index.js").Permission;

const BOT = "software-factory[bot]";
const REPO = "render-examples/render-factory-example-target";
const ctx = { metadata: { taskRunId: "trn-cancel" } };

function fakeGitHub(permission: Permission) {
	const comments: IssueComment[] = [];
	const labels = new Set<string>([WORKING_LABEL]);
	let nextId = 1;
	const add = (login: string, body: string): IssueComment => {
		const comment = {
			id: nextId++,
			body,
			author: { login, type: "Bot" },
			performedViaApp: null,
			createdAt: "",
			updatedAt: "",
			htmlUrl: "",
		};
		comments.push(comment);
		return comment;
	};
	const gh = {
		botLogin: async () => BOT,
		listIssueComments: async () => comments.map((c) => ({ ...c })),
		createComment: async (_n: number, body: string) => add(BOT, body),
		updateComment: async (id: number, body: string) => {
			const comment = comments.find((c) => c.id === id) as IssueComment;
			comment.body = body;
			return comment;
		},
		ensureLabel: async () => {},
		addLabels: async () => {},
		removeLabel: async (_n: number, label: string) => {
			labels.delete(label);
		},
		getPermission: async () => permission,
	};
	return { gh, comments, labels, add };
}

function fakeRuns(statuses: Record<string, string>) {
	return {
		getTaskRun: vi.fn(async (id: string) => ({ status: statuses[id] ?? "succeeded" })),
		cancelTaskRun: vi.fn(async (id: string) => {
			statuses[id] = "canceled";
		}),
	};
}

beforeEach(() => {
	events.length = 0;
	claims.length = 0;
});

describe("cancel task", () => {
	it("cancels the active run recorded in the status comment and says who cancelled it", async () => {
		const { gh, comments, labels, add } = fakeGitHub("write");
		add(BOT, `running\n\n${renderMarker("status", { runId: "trn-1", phase: "spec-to-pr", state: "running" })}`);
		const runs = fakeRuns({ "trn-1": "running" });
		const result = await cancelRun(ctx, { repo: REPO, installationId: 5, number: 12, kind: "issue", actor: "alice" }, { gh, runs });
		expect(result).toEqual({ cancelled: true, runId: "trn-1" });
		expect(runs.cancelTaskRun).toHaveBeenCalledWith("trn-1");
		expect(comments).toHaveLength(1);
		expect(comments[0]?.body).toContain("**Spec-to-PR** was cancelled: cancelled by @alice.");
		expect(parseMarker(comments[0]?.body ?? "", "status")).toMatchObject({ runId: "trn-1", state: "cancelled" });
		expect(labels.has(WORKING_LABEL)).toBe(false);
		expect(events.map((e) => e.type)).toEqual(["run.started", "run.finished"]);
		expect(events[0]).toMatchObject({ traceId: "trn-cancel", runId: "trn-cancel", repo: REPO });
		expect(claims).toEqual([{ traceId: "trn-cancel", runId: "trn-cancel", repo: REPO, subject: "issue#12", phase: "cancel", actor: "alice" }]);
	});

	it("refuses an actor without permission and leaves the run alone", async () => {
		const { gh, comments, add } = fakeGitHub("read");
		add(BOT, renderMarker("status", { runId: "trn-1", phase: "triage", state: "running" }));
		const runs = fakeRuns({ "trn-1": "running" });
		const result = await cancelRun(ctx, { repo: REPO, installationId: 5, number: 12, kind: "issue", actor: "bob" }, { gh, runs });
		expect(result).toEqual({ cancelled: false, reason: "permission-denied" });
		expect(runs.cancelTaskRun).not.toHaveBeenCalled();
		expect(claims).toHaveLength(0);
		expect(comments.at(-1)?.body).toContain("@bob needs `write` permission");
		expect(parseMarker(comments[0]?.body ?? "", "status")?.state).toBe("running");
	});
});
