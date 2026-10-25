import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "../app/events/index.js";

const events: FactoryEvent[] = [];
vi.mock("../app/events/index.js", () => ({
	emit: (event: FactoryEvent) => {
		events.push(event);
	},
}));

const { config } = await import("../app/config/index.js");
const { parseMarker, renderMarker } = await import("../app/github/index.js");
const { WORKING_LABEL } = await import("../app/claims/index.js");
const { cancelRun } = await import("../app/workflows/cancel.js");
type IssueComment = import("../app/github/index.js").IssueComment;
type Permission = import("../app/github/index.js").Permission;

const BOT = "software-factory[bot]";
const REPO = Object.keys(config.repos)[0];
if (!REPO) throw new Error("factory.config.ts must configure at least one repository");
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
		terminateSandbox: vi.fn(async (_id: string) => {}),
	};
}

beforeEach(() => {
	events.length = 0;
});

describe("cancel task", () => {
	it("cancels the active run recorded in the status comment, terminates its sandbox, and says who cancelled it", async () => {
		const { gh, comments, labels, add } = fakeGitHub("write");
		const marker = renderMarker("status", {
			runId: "trn-1",
			traceId: "trn-root",
			rootStage: "autopilot",
			stage: "spec-to-pr",
			title: "Spec-to-PR",
			state: "running",
			sandboxId: "sbx-1",
		});
		add(BOT, `running\n\n${marker}`);
		const runs = fakeRuns({ "trn-root": "running" });
		const result = await cancelRun(ctx, { repo: REPO, installationId: 5, number: 12, kind: "issue", actor: "alice" }, { gh, runs });
		expect(result).toEqual({ cancelled: true, runId: "trn-root", currentRunId: "trn-1" });
		expect(runs.cancelTaskRun).toHaveBeenCalledWith("trn-root");
		expect(runs.terminateSandbox).toHaveBeenCalledWith("sbx-1");
		expect(comments).toHaveLength(1);
		expect(comments[0]?.body).toContain("**Spec-to-PR** was cancelled: cancelled by @alice.");
		expect(parseMarker(comments[0]?.body ?? "", "status")).toMatchObject({ runId: "trn-1", state: "cancelled" });
		expect(labels.has(WORKING_LABEL)).toBe(false);
		expect(events.map((e) => [e.type, e.runId])).toEqual([
			["run.finished", "trn-1"],
			["run.finished", "trn-root"],
			["run.finished", "trn-cancel"],
		]);
		expect(events[0]?.payload).toMatchObject({ state: "cancelled", outcome: "cancelled", stoppedBy: "trn-cancel" });
		expect(events[0]).toMatchObject({ traceId: "trn-root", runId: "trn-1" });
		expect(events[1]).toMatchObject({
			traceId: "trn-root",
			runId: "trn-root",
			payload: { stage: "autopilot", state: "cancelled", outcome: "cancelled", stoppedBy: "trn-cancel", currentRunId: "trn-1" },
		});
		expect(events[2]).toMatchObject({ traceId: "trn-cancel", runId: "trn-cancel", repo: REPO });
	});

	it("clears a status left running by a run that already stopped, and terminates its leftover sandbox", async () => {
		const { gh, comments, labels, add } = fakeGitHub("write");
		const marker = renderMarker("status", { runId: "trn-dead", stage: "triage", title: "Triage", state: "running", sandboxId: "sbx-dead" });
		add(BOT, `running\n\n${marker}`);
		const runs = fakeRuns({});
		const result = await cancelRun(ctx, { repo: REPO, installationId: 5, number: 12, kind: "issue", actor: "alice" }, { gh, runs });
		expect(result).toEqual({ cancelled: false, runId: "trn-dead", reason: "already_stopped" });
		expect(runs.cancelTaskRun).not.toHaveBeenCalled();
		expect(runs.terminateSandbox).toHaveBeenCalledWith("sbx-dead");
		expect(comments).toHaveLength(1);
		expect(comments[0]?.body).toContain("**Triage** was cancelled: cleared by @alice; the run had already stopped without finishing.");
		expect(labels.has(WORKING_LABEL)).toBe(false);
	});

	it("cancels the root without reclassifying a child that already finished", async () => {
		const { gh, comments, labels, add } = fakeGitHub("write");
		const marker = renderMarker("status", {
			runId: "trn-child",
			traceId: "trn-root",
			rootStage: "autopilot",
			stage: "triage",
			title: "Triage",
			state: "done",
		});
		add(BOT, `done\n\n${marker}`);
		const runs = fakeRuns({ "trn-root": "running" });
		const result = await cancelRun(ctx, { repo: REPO, installationId: 5, number: 12, kind: "issue", actor: "alice" }, { gh, runs });

		expect(result).toEqual({ cancelled: true, runId: "trn-root" });
		expect(runs.cancelTaskRun).toHaveBeenCalledWith("trn-root");
		expect(parseMarker(comments[0]?.body ?? "", "status")).toMatchObject({
			runId: "trn-root",
			traceId: "trn-root",
			stage: "autopilot",
			state: "cancelled",
		});
		expect(labels.has(WORKING_LABEL)).toBe(false);
		expect(events.map((event) => event.runId)).toEqual(["trn-root", "trn-cancel"]);
	});

	it("refuses an actor without permission and leaves the run alone", async () => {
		const { gh, comments, add } = fakeGitHub("read");
		add(BOT, renderMarker("status", { runId: "trn-1", stage: "triage", state: "running" }));
		const runs = fakeRuns({ "trn-1": "running" });
		const result = await cancelRun(ctx, { repo: REPO, installationId: 5, number: 12, kind: "issue", actor: "bob" }, { gh, runs });
		expect(result).toEqual({ cancelled: false, reason: "permission_denied" });
		expect(runs.cancelTaskRun).not.toHaveBeenCalled();
		expect(runs.terminateSandbox).not.toHaveBeenCalled();
		expect(comments.at(-1)?.body).toContain("@bob needs `write` permission");
		expect(parseMarker(comments[0]?.body ?? "", "status")?.state).toBe("running");
	});
});
