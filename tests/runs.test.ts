import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "../app/agent-runs/index.js";
import { requireRepo } from "../app/config/index.js";
import { append, type Db, readStream, rebuild } from "../app/db/index.js";
import { runFinished, runProgress } from "../app/events/index.js";
import { parseMarker } from "../app/github/index.js";
import { type Run, type RunOptions, runEvent, syncStatus, WORKING_LABEL, withRun } from "../app/runs/index.js";
import { githubThread } from "../app/threads/index.js";
import { REPO as REPO_NAME } from "./fixtures/config.js";
import { pgliteDb, resetDb } from "./helpers/db.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { FakeRuns, runRow, startRun } from "./helpers/runs.js";

const REPO = requireRepo(REPO_NAME, 5);
const thread = { kind: "issue" as const, number: 12 };
const KEY = githubThread(REPO.fullName, thread);

let db: Db;
beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
beforeEach(async () => {
	await resetDb(db);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

const root = (taskRunId: string) => ({ metadata: { taskRunId, rootTaskRunId: taskRunId } });
const child = (taskRunId: string, rootTaskRunId: string) => ({ metadata: { taskRunId, rootTaskRunId, parentTaskRunId: rootTaskRunId } });
const options = (gh: FakeGitHub, overrides: Partial<RunOptions> = {}): RunOptions => ({
	repo: REPO,
	thread,
	task: "triage",
	title: "Triage",
	actor: "maintainer",
	gh: gh.asClient(),
	runs: new FakeRuns(),
	db,
	...overrides,
});
const done = async () => ({ outcome: "done", summary: "done." });
const types = async (stream: string) => (await readStream(db, stream, 0)).map((event) => event.type);
const owner = async () =>
	(await db.query<{ trace_id: string; run_id: string }>("select trace_id, run_id from threads where thread = $1", [KEY])).rows[0];
const record = (event: Parameters<typeof append>[1]) => db.withTx((tx) => append(tx, event));

describe("withRun", () => {
	it("starts on the thread and shows the run's progress in the status comment until it finishes", async () => {
		const gh = new FakeGitHub();
		const outcome = await withRun(root("trn-run"), options(gh), async (run) => {
			expect(gh.status()).toContain("**Triage** is running");
			expect(gh.labels(12).has(WORKING_LABEL)).toBe(true);
			await run.trackSandbox({ id: "sbx-run" });
			await run.reportProgress("reading the issue");
			expect(gh.status()).toContain("**Triage** is running: reading the issue");
			expect(await runRow(db, "trn-run")).toMatchObject({ state: "running", sandbox_id: "sbx-run" });
			return { outcome: "asked", summary: "asked 2 questions.", links: [{ label: "Questions", url: "https://github.test/q" }] };
		});

		expect(outcome).toEqual({ state: "done", outcome: "asked", summary: "asked 2 questions.", traceId: "trn-run", runId: "trn-run" });
		expect(gh.comments).toHaveLength(1);
		const body = gh.status();
		expect(body).toContain("**Triage** finished: asked 2 questions.\n\n- [Questions](https://github.test/q)");
		expect(body).toContain(`run \`trn-run\` · events: \`/threads/github/${REPO.fullName}/issue/12/stream\``);
		expect(parseMarker(body, "status")).toEqual({ runId: "trn-run", traceId: "trn-run", stage: "triage", title: "Triage", state: "done" });
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(false);
		expect(await runRow(db, "trn-run")).toMatchObject({ state: "done", outcome: "asked" });
	});

	it("rejects an actor without permission without starting, and says so only on a thread with no runs, once", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { reader: "read" };
		const work = vi.fn();
		const outcome = await withRun(root("trn-1"), options(gh, { actor: "reader" }), work);
		await withRun(root("trn-2"), options(gh, { actor: "reader" }), work);

		expect(work).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ state: "rejected", outcome: "permission_denied", traceId: "trn-1", runId: "trn-1" });
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain("**Triage** did not run: @reader needs `write` permission");
		expect(await runRow(db, "trn-2")).toMatchObject({ state: "rejected", outcome: "permission_denied" });
		expect(await types(`thread:${KEY}`)).toEqual([]);
		expect(await owner()).toBeUndefined();
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(false);
	});

	it("lets an unauthorized trigger displace nothing on a busy thread, and stays silent", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { reader: "read" };
		await startRun(db, REPO.fullName, thread, { traceId: "trn-busy", sandboxId: "sbx-busy" });
		const runs = new FakeRuns({ "trn-busy": "running" });
		await withRun(root("trn-denied"), options(gh, { actor: "reader", runs }), vi.fn());

		expect(gh.comments).toEqual([]);
		expect(runs.getTaskRun).not.toHaveBeenCalled();
		expect(runs.terminateSandbox).not.toHaveBeenCalled();
		expect(await runRow(db, "trn-busy")).toMatchObject({ state: "running" });
		expect(await owner()).toMatchObject({ trace_id: "trn-busy" });
		expect(await runRow(db, "trn-denied")).toMatchObject({ state: "rejected" });
	});

	it("takes over the thread: cancels the displaced trace, terminates its running child's sandbox, and records both stopped", async () => {
		const gh = new FakeGitHub();
		await startRun(db, REPO.fullName, thread, { traceId: "trn-old", task: "autopilot", title: "Autopilot" });
		await startRun(db, REPO.fullName, thread, { traceId: "trn-old", runId: "trn-child-old", sandboxId: "sbx-child" });
		const runs = new FakeRuns({ "trn-old": "paused" });
		await withRun(root("trn-new"), options(gh, { runs }), done);

		expect(runs.cancelled).toEqual(["trn-old"]);
		expect(runs.terminated).toEqual(["sbx-child"]);
		expect(await runRow(db, "trn-old")).toMatchObject({ state: "cancelled", outcome: "superseded", summary: "Triage by @maintainer took over." });
		expect(await runRow(db, "trn-child-old")).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect((await readStream(db, "run:trn-old", 0)).find((event) => event.type === "run.stopped")).toMatchObject({
			source: "workflow:trn-new",
			payload: { by: "trn-new", active: true },
		});
		expect(await owner()).toEqual({ trace_id: "trn-new", run_id: "trn-new" });
	});

	it("fences the displaced run even when cancelling it fails", async () => {
		const gh = new FakeGitHub();
		const runs = new FakeRuns({ "trn-old": "running" });
		runs.cancelTaskRun.mockRejectedValue(new Error("render is down"));
		let resume = () => {};
		const paused = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let entered = () => {};
		const working = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const old = withRun(root("trn-old"), options(gh, { runs }), async (run) => {
			entered();
			await paused;
			await run.reportProgress("writing");
			return { outcome: "done", summary: "done." };
		});
		await working;

		expect(await withRun(root("trn-new"), options(gh, { runs }), done)).toMatchObject({ state: "done" });
		resume();
		expect(await old).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(runs.cancelTaskRun).toHaveBeenCalledWith("trn-old");
		expect(gh.status()).toContain("run `trn-new`");
	});

	it("lets a child continue its own trace, and never lets a stale child take the thread back", async () => {
		const gh = new FakeGitHub();
		await startRun(db, REPO.fullName, thread, { traceId: "trn-root", task: "autopilot", title: "Autopilot" });
		const runs = new FakeRuns({ "trn-root": "running" });
		const stage = await withRun(child("trn-triage", "trn-root"), options(gh, { runs, mode: "continue" }), async () => ({
			outcome: "drafted",
			summary: "drafted spec v1.",
		}));

		expect(stage).toMatchObject({ state: "done", traceId: "trn-root", runId: "trn-triage" });
		expect(runs.getTaskRun).not.toHaveBeenCalled();
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(true);
		expect(await owner()).toEqual({ trace_id: "trn-root", run_id: "trn-triage" });

		await startRun(db, REPO.fullName, thread, { traceId: "trn-new-root" });
		const work = vi.fn();
		const late = await withRun(child("trn-late", "trn-root"), options(gh, { runs, mode: "continue" }), work);
		expect(late).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(work).not.toHaveBeenCalled();
		expect(await owner()).toEqual({ trace_id: "trn-new-root", run_id: "trn-new-root" });
		expect(await types("run:trn-late")).toEqual([]);
	});

	it("stops at a checkpoint after a newer run starts on the thread", async () => {
		const gh = new FakeGitHub();
		const outcome = await withRun(root("trn-run"), options(gh), async (run: Run) => {
			await startRun(db, REPO.fullName, thread, { traceId: "trn-new" });
			await run.reportProgress("doing expensive work");
			return { outcome: "done", summary: "done." };
		});
		expect(outcome).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(gh.status()).not.toContain("doing expensive work");
		expect(await runRow(db, "trn-run")).toMatchObject({ state: "cancelled", outcome: "superseded" });
	});

	it("records an unexpected error without leaking it, and rethrows", async () => {
		const gh = new FakeGitHub();
		const boom = new Error("connect ECONNREFUSED token=ghs_secret");
		await expect(
			withRun(root("trn-run"), options(gh), async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
		const body = gh.status();
		expect(body).toContain("**Triage** failed: something went wrong");
		expect(body).not.toContain("ghs_secret");
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(false);
		expect(await runRow(db, "trn-run")).toMatchObject({ state: "failed", outcome: "error" });
		expect(JSON.stringify(await readStream(db, "run:trn-run", 0))).not.toContain("ghs_secret");
	});

	it("ends as superseded, without rethrowing, when an error follows a takeover", async () => {
		const gh = new FakeGitHub();
		const runs = new FakeRuns({ "trn-old": "running" });
		const outcome = await withRun(root("trn-old"), options(gh, { runs }), async (run) => {
			await run.trackSandbox({ id: "sbx-old" });
			await withRun(root("trn-new"), options(gh, { runs }), async () => ({ outcome: "drafted", summary: "drafted spec v1." }));
			throw new Error("sandbox sbx-old was terminated");
		});

		expect(outcome).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(runs.terminated).toEqual(["sbx-old"]);
		expect(await runRow(db, "trn-old")).toMatchObject({ state: "cancelled", outcome: "superseded", summary: "Triage by @maintainer took over." });
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain("**Triage** finished: drafted spec v1.");
		expect(gh.status()).toContain("run `trn-new`");
	});

	it("reports a model-side agent stop on GitHub, but fails the task for a platform-side agent error", async () => {
		const gh = new FakeGitHub();
		const stopped = await withRun(root("trn-stop"), options(gh), async () => {
			throw new AgentError("triage", "max_turns", "turn limit (40) after reading /secret/path");
		});
		expect(stopped).toMatchObject({ state: "failed", outcome: "agent_stopped" });
		expect(gh.status()).toContain("the triage agent ran out of turns");
		expect(gh.status()).not.toContain("/secret/path");

		const lost = new AgentError("triage", "runner_lost", "the runner ended without a result");
		await expect(
			withRun(root("trn-lost"), options(gh), async () => {
				throw lost;
			}),
		).rejects.toBe(lost);
	});

	it("keeps working through a GitHub outage and retries the final status", async () => {
		const gh = new FakeGitHub();
		gh.failNext("createComment");
		const outcome = await withRun(root("trn-run"), options(gh), async () => {
			gh.failNext("createComment");
			return { outcome: "done", summary: "all done." };
		});
		expect(outcome).toMatchObject({ state: "done" });
		expect(gh.status()).toContain("**Triage** finished: all done.");
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(false);
	});

	it("recreates a status comment someone deleted", async () => {
		const gh = new FakeGitHub();
		await withRun(root("trn-run"), options(gh), async (run) => {
			gh.comments = [];
			await run.reportProgress("still here");
			return { outcome: "done", summary: "done." };
		});
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain("**Triage** finished: done.");
	});
});

describe("the status comment", () => {
	it("is created once when two first syncs race", async () => {
		const gh = new FakeGitHub();
		await startRun(db, REPO.fullName, thread, { traceId: "trn-run" });
		let bothCreating = () => {};
		const barrier = new Promise<void>((resolve) => {
			bothCreating = resolve;
		});
		let creating = 0;
		const create = gh.createComment;
		gh.createComment = async (number, body) => {
			if (++creating === 2) bothCreating();
			await barrier;
			return create(number, body);
		};

		await Promise.all([syncStatus(db, gh, REPO.fullName, thread), syncStatus(db, gh, REPO.fullName, thread)]);

		expect(creating).toBe(2);
		expect(gh.comments).toHaveLength(1);
		const { rows } = await db.query<{ id: string | number }>("select status_comment_id as id from threads where thread = $1", [KEY]);
		expect(Number(rows[0]?.id)).toBe(gh.comments[0]?.id);
	});

	it("shows the trace's running child, even after its root changed, and the root once the child ends", async () => {
		const gh = new FakeGitHub();
		await startRun(db, REPO.fullName, thread, { traceId: "trn-root", task: "autopilot", title: "Autopilot" });
		await startRun(db, REPO.fullName, thread, { traceId: "trn-root", runId: "trn-child", task: "spec-to-pr", title: "Spec-to-PR" });
		await record(runEvent(runProgress, "trn-root", KEY, { summary: "implementing the spec" }));

		await syncStatus(db, gh, REPO.fullName, thread);
		expect(gh.status()).toContain("**Spec-to-PR** is running");

		await record(
			runEvent(runFinished, "trn-child", KEY, { state: "done", outcome: "pr_opened", summary: "opened draft PR #34.", links: [], duration_ms: 1 }),
		);
		await syncStatus(db, gh, REPO.fullName, thread);
		expect(gh.status()).toContain("**Autopilot** is running: implementing the spec");
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(true);

		await record(
			runEvent(runFinished, "trn-root", KEY, { state: "done", outcome: "completed", summary: "opened PR #34.", links: [], duration_ms: 1 }),
		);
		await syncStatus(db, gh, REPO.fullName, thread);
		expect(gh.status()).toContain("**Autopilot** finished: opened PR #34.");
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(false);
		expect(gh.comments).toHaveLength(1);
	});
});

describe("db:rebuild", () => {
	it("recreates runs, threads, and links from the log and keeps the status comment's ID", async () => {
		const gh = new FakeGitHub();
		gh.permissions.reader = "read";
		await startRun(db, REPO.fullName, thread, { traceId: "trn-old", sandboxId: "sbx-old" });
		await withRun(root("trn-new"), options(gh, { runs: new FakeRuns({ "trn-old": "running" }) }), async (run) => {
			await run.reportProgress("working");
			await run.linkThread({ kind: "pr", number: 34 });
			return { outcome: "done", summary: "done.", links: [{ label: "Spec v1", url: "https://github.test/s" }], waiting: "reply" };
		});
		await withRun(root("trn-denied"), options(gh, { actor: "reader" }), done);
		const tables = ["runs", "threads", "thread_links"];
		const snapshot = () => Promise.all(tables.map(async (table) => (await db.query(`select * from ${table} order by 1`)).rows));
		const before = await snapshot();
		expect(before[0]).toContainEqual(expect.objectContaining({ run_id: "trn-new", waiting: "reply" }));
		expect(before[1]).toMatchObject([{ status_comment_id: expect.anything() }]);
		expect(before[2]).toMatchObject([{ linked_to: githubThread(REPO.fullName, thread) }]);

		await rebuild(db);
		expect(await snapshot()).toEqual(before);
	});
});
