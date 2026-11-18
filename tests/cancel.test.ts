import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { append, type Db } from "../app/db/index.js";
import { runFinished } from "../app/events/index.js";
import { runEvent, syncStatus, WORKING_LABEL } from "../app/runs/index.js";
import { githubThread } from "../app/threads/index.js";
import { runCancel } from "../app/workflows/cancel.js";
import { REPO } from "./fixtures/config.js";
import { pgliteDb, resetDb } from "./helpers/db.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { FakeRuns, runRow, startRun } from "./helpers/runs.js";

const ctx = { metadata: { taskRunId: "trn-cancel" } };
const thread = { kind: "issue" as const, number: 12 };
const KEY = githubThread(REPO, thread);
const input = (actor = "alice") => ({ repo: REPO, installationId: 5, number: 12, kind: "issue", actor });

let db: Db;
beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
beforeEach(() => resetDb(db));

async function autopilotAtSpecToPr(gh: FakeGitHub, childState: "running" | "done" = "running") {
	await startRun(db, REPO, thread, { traceId: "trn-root", task: "autopilot", title: "Autopilot" });
	await startRun(db, REPO, thread, { traceId: "trn-root", runId: "trn-1", task: "spec-to-pr", title: "Spec-to-PR", sandboxId: "sbx-1" });
	if (childState === "done") {
		const finished = { state: "done" as const, outcome: "pr_opened", summary: "opened draft PR #34.", links: [], duration_ms: 1 };
		await db.withTx((tx) => append(tx, runEvent(runFinished, "trn-1", KEY, finished)));
	}
	await syncStatus(db, gh, REPO, thread);
}

describe("cancel task", () => {
	it("stops the running trace and its current child, and shows that in the status comment", async () => {
		const gh = new FakeGitHub();
		await autopilotAtSpecToPr(gh);
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(true);
		const runs = new FakeRuns({ "trn-root": "running" });

		const result = await runCancel(ctx, input(), { gh: gh.asClient(), runs, db });

		const summary = "cancelled `trn-root` and its current run `trn-1`.";
		expect(result).toMatchObject({ state: "done", outcome: "cancelled", summary });
		expect(runs.cancelled).toEqual(["trn-root"]);
		expect(runs.terminated).toEqual(["sbx-1"]);
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain(`**Cancel** finished: ${summary}`);
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(false);
		expect(await runRow(db, "trn-root")).toMatchObject({ state: "cancelled", summary: "Cancel by @alice took over." });
		expect(await runRow(db, "trn-1")).toMatchObject({ state: "cancelled", summary: "Cancel by @alice took over." });
		expect(await runRow(db, "trn-cancel")).toMatchObject({ state: "done", outcome: "cancelled" });
	});

	it("cancels the root without reclassifying a child that already finished", async () => {
		const gh = new FakeGitHub();
		await autopilotAtSpecToPr(gh, "done");
		const runs = new FakeRuns({ "trn-root": "running" });

		const result = await runCancel(ctx, input(), { gh: gh.asClient(), runs, db });

		expect(result).toMatchObject({ outcome: "cancelled", summary: "cancelled `trn-root`." });
		expect(runs.terminated).toEqual([]);
		expect(await runRow(db, "trn-1")).toMatchObject({ state: "done" });
		expect(gh.status()).toContain("**Cancel** finished: cancelled `trn-root`.");
	});

	it("closes runs left running by a trace Render already stopped, and terminates their sandbox", async () => {
		const gh = new FakeGitHub();
		await startRun(db, REPO, thread, { traceId: "trn-dead", sandboxId: "sbx-dead" });
		const runs = new FakeRuns();

		expect(await runCancel(ctx, input(), { gh: gh.asClient(), runs, db })).toMatchObject({ outcome: "cancelled", summary: "cancelled `trn-dead`." });
		expect(runs.cancelTaskRun).not.toHaveBeenCalled();
		expect(runs.terminated).toEqual(["sbx-dead"]);
		expect(await runRow(db, "trn-dead")).toMatchObject({ state: "cancelled" });
	});

	it.each([
		{
			thread: "a finished trace",
			seed: async (gh: FakeGitHub) => {
				await autopilotAtSpecToPr(gh, "done");
				const finished = { state: "done" as const, outcome: "completed", summary: "done.", links: [], duration_ms: 1 };
				await db.withTx((tx) => append(tx, runEvent(runFinished, "trn-root", KEY, finished)));
			},
		},
		{ thread: "no runs", seed: async () => {} },
	])("shows that nothing was running on a thread with $thread in one status comment, and posts nothing else", async ({ seed }) => {
		const gh = new FakeGitHub();
		await seed(gh);
		const runs = new FakeRuns();

		expect(await runCancel(ctx, input(), { gh: gh.asClient(), runs, db })).toMatchObject({
			outcome: "nothing_running",
			summary: "nothing was running.",
		});
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain("**Cancel** finished: nothing was running.");
		expect(runs.getTaskRun).not.toHaveBeenCalled();
	});

	it("refuses actors without permission without touching the run or commenting on a busy thread", async () => {
		const gh = new FakeGitHub();
		await autopilotAtSpecToPr(gh);
		const runs = new FakeRuns({ "trn-root": "running" });

		for (const taskRunId of ["trn-bob-1", "trn-bob-2", "trn-bob-3"]) {
			const result = await runCancel({ metadata: { taskRunId } }, input("bob"), { gh: gh.asClient(), runs, db });
			expect(result).toMatchObject({ state: "rejected", outcome: "permission_denied" });
			expect(await runRow(db, taskRunId)).toMatchObject({ state: "rejected" });
		}
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain("**Spec-to-PR** is running");
		expect(runs.getTaskRun).not.toHaveBeenCalled();
		expect(runs.terminateSandbox).not.toHaveBeenCalled();
		expect(await runRow(db, "trn-1")).toMatchObject({ state: "running" });
	});

	it("tells an actor without permission once on a thread with no runs", async () => {
		const gh = new FakeGitHub();
		await runCancel({ metadata: { taskRunId: "trn-bob-1" } }, input("bob"), { gh: gh.asClient(), db });
		await runCancel({ metadata: { taskRunId: "trn-bob-2" } }, input("bob"), { gh: gh.asClient(), db });
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain("**Cancel** did not run: @bob needs `write` permission");
	});
});
