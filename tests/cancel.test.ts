import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readClaim, runEvent, syncStatus, WORKING_LABEL } from "../app/claims/index.js";
import { append, type Db } from "../app/db/index.js";
import { runFinished } from "../app/events/index.js";
import type { IssueComment, Permission } from "../app/github/index.js";
import { githubThread } from "../app/threads/index.js";
import { cancelRun } from "../app/workflows/cancel.js";
import { REPO } from "./fixtures/config.js";
import { FakeRuns, holdClaim, runRow } from "./helpers/claims.js";
import { pgliteDb, resetDb } from "./helpers/db.js";

const ctx = { metadata: { taskRunId: "trn-cancel" } };
const thread = { kind: "issue" as const, number: 12 };
const KEY = githubThread(REPO, thread);
const input = (actor = "alice") => ({ repo: REPO, installationId: 5, number: 12, kind: "issue", actor });

function fakeGitHub(permission: Permission) {
	const comments: IssueComment[] = [];
	const labels = new Set<string>();
	const gh = {
		createComment: async (_n: number, body: string) => {
			const comment = {
				id: comments.length + 1,
				body,
				author: { login: "software-factory[bot]", type: "Bot" },
				createdAt: "",
				updatedAt: "",
				htmlUrl: "",
			};
			comments.push(comment);
			return comment;
		},
		updateComment: async (id: number, body: string) => {
			const comment = comments.find((c) => c.id === id) as IssueComment;
			comment.body = body;
			return comment;
		},
		ensureLabel: async () => {},
		addLabels: async (_n: number, added: readonly string[]) => {
			for (const label of added) labels.add(label);
		},
		removeLabel: async (_n: number, label: string) => {
			labels.delete(label);
		},
		getPermission: async () => permission,
	};
	return { gh, comments, labels };
}

let db: Db;
beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
beforeEach(() => resetDb(db));

/** An autopilot root whose Spec-to-PR child holds the claim, with the status comment showing it. */
async function autopilotAtSpecToPr(gh: ReturnType<typeof fakeGitHub>["gh"], childState: "running" | "done" = "running") {
	await holdClaim(db, REPO, thread, { traceId: "trn-root", task: "autopilot", title: "Autopilot" });
	await holdClaim(db, REPO, thread, { traceId: "trn-root", runId: "trn-1", task: "spec-to-pr", title: "Spec-to-PR", sandboxId: "sbx-1" });
	if (childState === "done") {
		const finished = { state: "done" as const, outcome: "pr_opened", summary: "opened draft PR #34.", links: [], duration_ms: 1 };
		await db.withTx((tx) => append(tx, runEvent(runFinished, "trn-1", KEY, finished)));
	}
	await syncStatus(db, gh, REPO, thread);
}

describe("cancel task", () => {
	it("cancels the trace holding the claim, terminates its sandbox, and says who cancelled it", async () => {
		const { gh, comments, labels } = fakeGitHub("write");
		await autopilotAtSpecToPr(gh);
		expect(labels.has(WORKING_LABEL)).toBe(true);
		const runs = new FakeRuns({ "trn-root": "running" });

		const result = await cancelRun(ctx, input(), { gh, runs, db });

		expect(result).toEqual({ cancelled: true, runId: "trn-root", currentRunId: "trn-1" });
		expect(runs.cancelled).toEqual(["trn-root"]);
		expect(runs.terminated).toEqual(["sbx-1"]);
		expect(comments).toHaveLength(1);
		expect(comments[0]?.body).toContain("**Spec-to-PR** was cancelled: cancelled by @alice.");
		expect(labels.has(WORKING_LABEL)).toBe(false);
		expect(await runRow(db, "trn-root")).toMatchObject({ state: "cancelled", outcome: "cancelled" });
		expect(await runRow(db, "trn-1")).toMatchObject({ state: "cancelled", outcome: "cancelled" });
		expect(await readClaim(db, KEY)).toMatchObject({ traceId: "trn-root", held: false });
		expect(await runRow(db, "trn-cancel")).toMatchObject({ state: "done", outcome: "cancelled" });
	});

	it("closes a run left running by a trace that already stopped, and terminates its leftover sandbox", async () => {
		const { gh, comments } = fakeGitHub("write");
		await holdClaim(db, REPO, thread, { traceId: "trn-dead", sandboxId: "sbx-dead" });
		const runs = new FakeRuns();

		const result = await cancelRun(ctx, input(), { gh, runs, db });

		expect(result).toEqual({ cancelled: false, runId: "trn-dead", reason: "already_stopped" });
		expect(runs.cancelTaskRun).not.toHaveBeenCalled();
		expect(runs.terminated).toEqual(["sbx-dead"]);
		expect(comments.at(-1)?.body).toContain("**Triage** was cancelled: cleared by @alice; the run had already stopped without finishing.");
		expect(await readClaim(db, KEY)).toMatchObject({ held: false });
	});

	it("cancels the root without reclassifying a child that already finished", async () => {
		const { gh, comments, labels } = fakeGitHub("write");
		await autopilotAtSpecToPr(gh, "done");
		const runs = new FakeRuns({ "trn-root": "running" });

		const result = await cancelRun(ctx, input(), { gh, runs, db });

		expect(result).toEqual({ cancelled: true, runId: "trn-root" });
		expect(runs.terminated).toEqual([]);
		expect(await runRow(db, "trn-1")).toMatchObject({ state: "done" });
		expect(comments[0]?.body).toContain("**Autopilot** was cancelled: cancelled by @alice.");
		expect(labels.has(WORKING_LABEL)).toBe(false);
	});

	it("says nothing is running when no trace holds the claim", async () => {
		const { gh, comments } = fakeGitHub("write");
		const runs = new FakeRuns();
		expect(await cancelRun(ctx, input(), { gh, runs, db })).toEqual({ cancelled: false, reason: "nothing_running" });
		expect(comments.at(-1)?.body).toBe("@alice no factory run is in progress here.");
		expect(runs.getTaskRun).not.toHaveBeenCalled();
	});

	it("refuses an actor without permission and leaves the run alone", async () => {
		const { gh, comments } = fakeGitHub("read");
		await holdClaim(db, REPO, thread, { traceId: "trn-1", sandboxId: "sbx-1" });
		const runs = new FakeRuns({ "trn-1": "running" });

		const result = await cancelRun(ctx, input("bob"), { gh, runs, db });

		expect(result).toEqual({ cancelled: false, reason: "permission_denied" });
		expect(runs.cancelTaskRun).not.toHaveBeenCalled();
		expect(runs.terminateSandbox).not.toHaveBeenCalled();
		expect(comments.at(-1)?.body).toContain("@bob needs `write` permission");
		expect(await runRow(db, "trn-1")).toMatchObject({ state: "running" });
		expect(await readClaim(db, KEY)).toMatchObject({ traceId: "trn-1", held: true });
		expect(await runRow(db, "trn-cancel")).toMatchObject({ state: "rejected", outcome: "permission_denied" });
	});
});
