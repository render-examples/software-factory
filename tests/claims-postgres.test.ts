import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquire, type Claim, readClaim, withClaim } from "../app/claims/index.js";
import { requireRepo } from "../app/config/index.js";
import { createDb, type Db, migrate, readStream } from "../app/db/index.js";
import type { GitHubClient } from "../app/github/index.js";
import { githubThread, type ThreadKey } from "../app/threads/index.js";
import { REPO } from "./fixtures/config.js";
import { FakeRuns } from "./helpers/claims.js";
import { postgresDatabase, TEST_DATABASE_URL } from "./helpers/db.js";

describe.skipIf(!TEST_DATABASE_URL)("claims on Postgres", () => {
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

	it("fences concurrent acquires, so each one replaces exactly the claim before it", async () => {
		const thread: ThreadKey = `github:acme/web#issue-${randomUUID()}`;
		const traces = ["trn-a", "trn-b", "trn-c"];
		const results = await Promise.all(traces.map((traceId) => acquire(db, { thread, traceId, runId: traceId, mode: "replace" })));

		expect(results.every(Boolean)).toBe(true);
		const claims = await readStream(db, `thread:${thread}`, 0);
		const payloads = claims.map((event) => event.payload as { trace_id: string; previous_trace_id: string | null });
		expect(claims.map((event) => event.streamVersion)).toEqual([1, 2, 3]);
		expect(payloads.map((payload) => payload.previous_trace_id)).toEqual([null, payloads[0]?.trace_id, payloads[1]?.trace_id]);
		expect(await readClaim(db, thread)).toMatchObject({ traceId: payloads[2]?.trace_id, held: true, streamVersion: 3 });
	});

	it("lets exactly one of two runs that start at once keep the claim", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const repo = requireRepo(REPO, 5);
		const thread = { kind: "issue" as const, number: Math.floor(Math.random() * 1_000_000) + 1 };
		let comments = 0;
		const gh = {
			createComment: async () => ({ id: ++comments }),
			updateComment: async (id: number) => ({ id }),
			ensureLabel: async () => {},
			addLabels: async () => {},
			removeLabel: async () => {},
			getPermission: async () => "write",
		} as unknown as GitHubClient;
		const runs = new FakeRuns({ "trn-x": "running", "trn-y": "running" });

		let arrived = 0;
		let bothClaimed = () => {};
		const barrier = new Promise<void>((resolve) => {
			bothClaimed = resolve;
		});
		const work = async (claim: Claim) => {
			if (++arrived === 2) bothClaimed();
			await barrier;
			await claim.reportProgress("writing");
			return { outcome: "done", summary: "done." };
		};
		const start = (taskRunId: string) =>
			withClaim(
				{ metadata: { taskRunId, rootTaskRunId: taskRunId } },
				{ repo, thread, task: "triage", title: "Triage", actor: "w", gh, runs, db },
				work,
			);
		const results = await Promise.all([start("trn-x"), start("trn-y")]);

		expect(results.map((result) => result.outcome).sort()).toEqual(["done", "superseded"]);
		const winner = results.find((result) => result.outcome === "done");
		const claims = await readStream(db, `thread:${githubThread(repo.fullName, thread)}`, 0);
		expect(claims.map((event) => event.type)).toEqual(["claim.acquired", "claim.acquired", "claim.released"]);
		expect(claims[1]?.payload).toMatchObject({ trace_id: winner?.traceId });
	});
});
