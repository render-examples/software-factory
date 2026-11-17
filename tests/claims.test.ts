import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "../app/agents/index.js";
import { type Claim, type ClaimOptions, readClaim, WORKING_LABEL, withClaim } from "../app/claims/index.js";
import { requireRepo } from "../app/config/index.js";
import { type Db, readStream, rebuild } from "../app/db/index.js";
import { type GitHubClient, GitHubError, type IssueComment, parseMarker, type Permission } from "../app/github/index.js";
import { githubThread } from "../app/threads/index.js";
import { REPO as REPO_NAME } from "./fixtures/config.js";
import { FakeRuns, holdClaim, runRow } from "./helpers/claims.js";
import { pgliteDb, resetDb } from "./helpers/db.js";

const BOT = "software-factory[bot]";
const REPO = requireRepo(REPO_NAME, 5);
const thread = { kind: "issue" as const, number: 12 };
const KEY = githubThread(REPO.fullName, thread);

class FakeGitHub {
	comments: IssueComment[] = [];
	labels = new Set<string>();
	permissions: Record<string, Permission> = { maintainer: "maintain" };
	/** How many more comment writes fail. */
	outage = 0;
	private nextId = 100;

	createComment = vi.fn(async (_number: number, body: string) => {
		this.down();
		const comment = { id: this.nextId++, body, author: { login: BOT, type: "Bot" }, createdAt: "", updatedAt: "", htmlUrl: "" };
		this.comments.push(comment);
		return { ...comment };
	});
	updateComment = vi.fn(async (id: number, body: string) => {
		this.down();
		const comment = this.comments.find((c) => c.id === id);
		if (!comment) throw new GitHubError(404, "Not Found");
		comment.body = body;
		return { ...comment };
	});
	ensureLabel = async () => {};
	addLabels = async (_number: number, labels: readonly string[]) => {
		for (const label of labels) this.labels.add(label);
	};
	removeLabel = async (_number: number, label: string) => {
		this.labels.delete(label);
	};
	getPermission = async (login: string) => this.permissions[login] ?? "none";

	status(): string {
		return this.comments.filter((c) => parseMarker(c.body, "status")).at(-1)?.body ?? "";
	}

	asClient(): GitHubClient {
		return this as unknown as GitHubClient;
	}

	private down(): void {
		if (this.outage <= 0) return;
		this.outage--;
		throw new Error("GitHub is down");
	}
}

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
const options = (gh: FakeGitHub, overrides: Partial<ClaimOptions> = {}): ClaimOptions => ({
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

describe("withClaim", () => {
	it("claims the thread and shows the run's progress in the status comment until it finishes", async () => {
		const gh = new FakeGitHub();
		const outcome = await withClaim(root("trn-run"), options(gh), async (claim) => {
			expect(gh.status()).toContain("**Triage** is running");
			expect(gh.labels.has(WORKING_LABEL)).toBe(true);
			await claim.trackSandbox({ id: "sbx-run" });
			await claim.reportProgress("reading the issue");
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
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(await types("run:trn-run")).toEqual(["run.started", "run.sandbox_attached", "run.progress", "run.finished"]);
		expect(await types(`thread:${KEY}`)).toEqual(["claim.acquired", "claim.released"]);
		expect((await readStream(db, "run:trn-run", 3))[0]?.payload).toMatchObject({ state: "done", outcome: "asked", duration_ms: expect.any(Number) });
	});

	it("rejects an actor without permission without claiming, and says so only the first time on an unclaimed thread", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { reader: "read" };
		const work = vi.fn();
		const outcome = await withClaim(root("trn-1"), options(gh, { actor: "reader" }), work);
		await withClaim(root("trn-2"), options(gh, { actor: "reader" }), work);

		expect(work).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ state: "rejected", outcome: "permission_denied", traceId: "trn-1", runId: "trn-1" });
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain("**Triage** did not run: @reader needs `write` permission");
		expect(await runRow(db, "trn-2")).toMatchObject({ state: "rejected", outcome: "permission_denied" });
		expect(await readClaim(db, KEY)).toBeNull();
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
	});

	it("supersedes the previous trace: cancels it, terminates its sandbox, and records it stopped", async () => {
		const gh = new FakeGitHub();
		await holdClaim(db, REPO.fullName, thread, { traceId: "trn-old", sandboxId: "sbx-old" });
		const runs = new FakeRuns({ "trn-old": "running" });
		await withClaim(root("trn-new"), options(gh, { runs }), done);

		expect(runs.cancelled).toEqual(["trn-old"]);
		expect(runs.terminated).toEqual(["sbx-old"]);
		expect(await runRow(db, "trn-old")).toMatchObject({ state: "cancelled", outcome: "superseded", summary: "a newer run took over." });
		expect((await readStream(db, "run:trn-old", 2))[0]).toMatchObject({
			type: "run.stopped",
			source: "workflow:trn-new",
			payload: { by: "trn-new", outcome: "superseded", active: true },
		});
		expect((await readStream(db, `thread:${KEY}`, 1))[0]?.payload).toMatchObject({ trace_id: "trn-new", previous_trace_id: "trn-old" });
	});

	it("cancels the previous root and closes its child when the child holds the claim", async () => {
		const gh = new FakeGitHub();
		await holdClaim(db, REPO.fullName, thread, { traceId: "trn-root-old", task: "autopilot", title: "Autopilot" });
		await holdClaim(db, REPO.fullName, thread, { traceId: "trn-root-old", runId: "trn-child-old", sandboxId: "sbx-child" });
		const runs = new FakeRuns({ "trn-root-old": "running" });
		await withClaim(root("trn-new"), options(gh, { runs }), done);

		expect(runs.cancelled).toEqual(["trn-root-old"]);
		expect(runs.terminated).toEqual(["sbx-child"]);
		expect(await runRow(db, "trn-root-old")).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(await runRow(db, "trn-child-old")).toMatchObject({ state: "cancelled", outcome: "superseded" });
	});

	it("fences the previous run even when cancelling it fails", async () => {
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
		const old = withClaim(root("trn-old"), options(gh, { runs }), async (claim) => {
			entered();
			await paused;
			await claim.reportProgress("writing");
			return { outcome: "done", summary: "done." };
		});
		await working;

		expect(await withClaim(root("trn-new"), options(gh, { runs }), done)).toMatchObject({ state: "done" });
		resume();
		expect(await old).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(runs.cancelTaskRun).toHaveBeenCalledWith("trn-old");
		expect(gh.status()).toContain("run `trn-new`");
	});

	it("lets a subtask continue its root's claim and turns away one from an older root", async () => {
		const gh = new FakeGitHub();
		await holdClaim(db, REPO.fullName, thread, { traceId: "trn-root", task: "autopilot", title: "Autopilot" });
		const runs = new FakeRuns({ "trn-root": "running" });
		const stage = await withClaim(child("trn-triage", "trn-root"), options(gh, { runs, mode: "continue" }), async () => ({
			outcome: "drafted",
			summary: "drafted spec v1.",
		}));

		expect(stage).toMatchObject({ state: "done", traceId: "trn-root", runId: "trn-triage" });
		expect(runs.getTaskRun).not.toHaveBeenCalled();
		expect(gh.status()).toContain("**Triage** finished: drafted spec v1.");
		expect(gh.labels.has(WORKING_LABEL)).toBe(true);
		expect(await readClaim(db, KEY)).toMatchObject({ traceId: "trn-root", runId: "trn-triage", held: true });

		const work = vi.fn();
		const late = await withClaim(child("trn-late", "trn-old-root"), options(gh, { runs, mode: "continue" }), work);
		expect(late).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(work).not.toHaveBeenCalled();
		expect(await readClaim(db, KEY)).toMatchObject({ traceId: "trn-root", runId: "trn-triage" });
	});

	it("stops at a checkpoint after a newer run claims the thread", async () => {
		const gh = new FakeGitHub();
		const outcome = await withClaim(root("trn-run"), options(gh), async (claim: Claim) => {
			await holdClaim(db, REPO.fullName, thread, { traceId: "trn-new" });
			await claim.reportProgress("doing expensive work");
			return { outcome: "done", summary: "done." };
		});
		expect(outcome).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(gh.status()).not.toContain("doing expensive work");
		expect(await readClaim(db, KEY)).toMatchObject({ traceId: "trn-new", held: true });
		expect(await runRow(db, "trn-run")).toMatchObject({ state: "cancelled", outcome: "superseded" });
	});

	it("records an unexpected error without leaking it, releases the claim, and rethrows", async () => {
		const gh = new FakeGitHub();
		const boom = new Error("connect ECONNREFUSED token=ghs_secret");
		await expect(
			withClaim(root("trn-run"), options(gh), async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
		const body = gh.status();
		expect(body).toContain("**Triage** failed: something went wrong");
		expect(body).not.toContain("ghs_secret");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(await runRow(db, "trn-run")).toMatchObject({ state: "failed", outcome: "error" });
		expect(JSON.stringify(await readStream(db, "run:trn-run", 0))).not.toContain("ghs_secret");
		expect(await readClaim(db, KEY)).toMatchObject({ held: false });
	});

	it("reports a model-side agent stop on GitHub, but fails the task for a platform-side agent error", async () => {
		const gh = new FakeGitHub();
		const stopped = await withClaim(root("trn-stop"), options(gh), async () => {
			throw new AgentError("triage", "max_turns", "turn limit (40) after reading /secret/path");
		});
		expect(stopped).toMatchObject({ state: "failed", outcome: "agent_stopped" });
		expect(gh.status()).toContain("the triage agent ran out of turns");
		expect(gh.status()).not.toContain("/secret/path");

		const lost = new AgentError("triage", "runner_lost", "the runner ended without a result");
		await expect(
			withClaim(root("trn-lost"), options(gh), async () => {
				throw lost;
			}),
		).rejects.toBe(lost);
	});

	it("keeps working through a GitHub outage and retries the final status", async () => {
		const gh = new FakeGitHub();
		gh.outage = 1;
		const outcome = await withClaim(root("trn-run"), options(gh), async (claim) => {
			expect(gh.comments).toEqual([]);
			await claim.reportProgress("working");
			expect(gh.status()).toContain("is running: working");
			gh.outage = 1;
			return { outcome: "done", summary: "all done." };
		});
		expect(outcome).toMatchObject({ state: "done" });
		expect(gh.status()).toContain("**Triage** finished: all done.");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
	});

	it("recreates a status comment someone deleted", async () => {
		const gh = new FakeGitHub();
		await withClaim(root("trn-run"), options(gh), async (claim) => {
			gh.comments = [];
			await claim.reportProgress("still here");
			return { outcome: "done", summary: "done." };
		});
		expect(gh.comments).toHaveLength(1);
		expect(gh.status()).toContain("**Triage** finished: done.");
	});
});

describe("db:rebuild", () => {
	it("recreates runs and claims from the log and keeps the status comment's ID", async () => {
		const gh = new FakeGitHub();
		await holdClaim(db, REPO.fullName, thread, { traceId: "trn-old", sandboxId: "sbx-old" });
		await withClaim(root("trn-new"), options(gh, { runs: new FakeRuns({ "trn-old": "running" }) }), async (claim) => {
			await claim.reportProgress("working");
			return { outcome: "done", summary: "done.", links: [{ label: "Spec v1", url: "https://github.test/s" }] };
		});
		const snapshot = async () => [(await db.query("select * from runs order by run_id")).rows, (await db.query("select * from claims")).rows];
		const before = await snapshot();
		expect(before[1]).toMatchObject([{ status_comment_id: expect.anything() }]);

		await rebuild(db);
		expect(await snapshot()).toEqual(before);
	});
});
