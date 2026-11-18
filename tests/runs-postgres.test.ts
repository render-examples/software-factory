import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireRepo } from "../app/config/index.js";
import { append, createDb, type Db, migrate, readStream, type Tx } from "../app/db/index.js";
import { runStarted } from "../app/events/index.js";
import type { GitHubClient } from "../app/github/index.js";
import { type Run, withRun } from "../app/runs/index.js";
import { startOnThread } from "../app/runs/thread.js";
import { githubThread, type ThreadKey } from "../app/threads/index.js";
import { REPO } from "./fixtures/config.js";
import { postgresDatabase, TEST_DATABASE_URL } from "./helpers/db.js";
import { FakeRuns } from "./helpers/runs.js";

describe.skipIf(!TEST_DATABASE_URL)("runs on Postgres", () => {
	let database: Awaited<ReturnType<typeof postgresDatabase>>;
	let db: Db;
	beforeAll(async () => {
		database = await postgresDatabase();
		db = createDb(database.url, 6);
		await migrate(db);
	});
	afterAll(async () => {
		await db.end();
		await database.drop();
	});

	const newThread = (): ThreadKey => `github:acme/web#issue-${randomUUID()}`;
	const starting = (thread: ThreadKey, traceId: string, runId = traceId) =>
		({ thread, traceId, runId, task: "triage", title: "Triage", actor: "w", mode: runId === traceId ? "replace" : "continue" }) as const;

	it("fences concurrent root starts, so each one displaces exactly the trace before it", async () => {
		const thread = newThread();
		const results = await Promise.all(["trn-a", "trn-b", "trn-c"].map((traceId) => startOnThread(db, starting(thread, traceId))));

		expect(results.every(Boolean)).toBe(true);
		const started = (await readStream(db, `thread:${thread}`, 0)).map((event) => event.payload as { trace_id: string });
		const displaced = new Map(started.map((payload, i) => [payload.trace_id, started[i - 1]?.trace_id ?? null]));
		for (const [i, traceId] of ["trn-a", "trn-b", "trn-c"].entries()) expect(results[i]).toEqual({ displaced: displaced.get(traceId) });
	});

	it("leaves one owner of two root runs that start at once; the other fails its next ownership check", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const repo = requireRepo(REPO, 5);
		const thread = { kind: "issue" as const, number: Math.floor(Math.random() * 1_000_000) + 1 };
		let comments = 0;
		const gh = {
			createComment: async () => ({ id: ++comments }),
			updateComment: async (id: number) => ({ id }),
			deleteComment: async () => {},
			ensureLabel: async () => {},
			addLabels: async () => {},
			removeLabel: async () => {},
			getPermission: async () => "write",
		} as unknown as GitHubClient;
		const runs = new FakeRuns({ "trn-x": "running", "trn-y": "running" });

		let arrived = 0;
		let bothStarted = () => {};
		const barrier = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});
		const work = async (run: Run) => {
			if (++arrived === 2) bothStarted();
			await barrier;
			await run.reportProgress("writing");
			return { outcome: "done", summary: "done." };
		};
		const start = (taskRunId: string) =>
			withRun(
				{ metadata: { taskRunId, rootTaskRunId: taskRunId } },
				{ repo, thread, task: "triage", title: "Triage", actor: "w", gh, runs, db },
				work,
			);
		const results = await Promise.all([start("trn-x"), start("trn-y")]);

		expect(results.map((result) => result.outcome).sort()).toEqual(["done", "superseded"]);
		const winner = results.find((result) => result.outcome === "done");
		const started = await readStream(db, `thread:${githubThread(repo.fullName, thread)}`, 0);
		expect(started.map((event) => event.type)).toEqual(["run.started", "run.started"]);
		expect(started[1]?.payload).toMatchObject({ trace_id: winner?.traceId });
	});

	it("rejects a child whose trace was displaced while it started", async () => {
		const thread = newThread();
		expect(await startOnThread(db, starting(thread, "trn-root"))).toEqual({ displaced: null });

		let commit = () => {};
		const committed = new Promise<void>((resolve) => {
			commit = resolve;
		});
		let appended = () => {};
		const newerAppended = new Promise<void>((resolve) => {
			appended = resolve;
		});
		const newer = db.withTx(async (tx: Tx) => {
			const payload = { run_id: "trn-newer", trace_id: "trn-newer", task: "triage", title: "Triage", actor: "w", mode: "replace" } as const;
			await append(tx, { type: runStarted, stream: `thread:${thread}`, thread, source: "workflow:trn-newer", payload }, { expectedVersion: 1 });
			appended();
			await committed;
		});
		await newerAppended;
		const childStart = startOnThread(db, starting(thread, "trn-root", "trn-child"));
		await untilATransactionWaitsOnALock(db);
		commit();
		await newer;

		expect(await childStart).toBeNull();
		const started = (await readStream(db, `thread:${thread}`, 0)).map((event) => (event.payload as { run_id: string }).run_id);
		expect(started).toEqual(["trn-root", "trn-newer"]);
	});
});

async function untilATransactionWaitsOnALock(db: Db): Promise<void> {
	for (let attempt = 0; attempt < 250; attempt++) {
		const { rows } = await db.query<{ waiting: number }>(
			"select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
		);
		if (rows[0]?.waiting) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("no transaction is waiting on a lock");
}
