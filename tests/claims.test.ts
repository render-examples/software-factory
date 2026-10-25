import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "../app/events/index.js";

const events: FactoryEvent[] = [];
vi.mock("../app/events/index.js", () => ({
	emit: (event: FactoryEvent) => {
		events.push(event);
	},
}));

const { AgentError } = await import("../app/agents/index.js");
const { config, requireRepo } = await import("../app/config/index.js");
const { renderMarker, parseMarker } = await import("../app/github/index.js");
type GitHubClient = import("../app/github/index.js").GitHubClient;
type IssueComment = import("../app/github/index.js").IssueComment;
type Permission = import("../app/github/index.js").Permission;
const { finishStatus, readStatus, takeOver, WORKING_LABEL, withClaim } = await import("../app/claims/index.js");

const BOT = "software-factory[bot]";
const REPO_NAME = Object.keys(config.repos)[0];
if (!REPO_NAME) throw new Error("factory.config.ts must configure at least one repository");
const REPO = requireRepo(REPO_NAME, 5);

class FakeGitHub {
	comments: IssueComment[] = [];
	labels = new Set<string>();
	permissions: Record<string, Permission> = {};
	private nextId = 100;

	botLogin = async () => BOT;
	listIssueComments = async (_number: number) => this.comments.map((c) => ({ ...c }));
	createComment = async (_number: number, body: string) => this.add(BOT, body);
	updateComment = async (id: number, body: string) => {
		const comment = this.comments.find((c) => c.id === id);
		if (!comment) throw new Error(`no comment ${id}`);
		comment.body = body;
		return { ...comment };
	};
	ensureLabel = async () => {};
	addLabels = async (_number: number, labels: readonly string[]) => {
		for (const label of labels) this.labels.add(label);
	};
	removeLabel = async (_number: number, label: string) => {
		this.labels.delete(label);
	};
	getPermission = async (login: string) => this.permissions[login] ?? "none";

	add(login: string, body: string): IssueComment {
		const comment = {
			id: this.nextId++,
			body,
			author: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			htmlUrl: "",
		};
		this.comments.push(comment);
		return { ...comment };
	}

	addStatus(
		runId: string,
		state: "running" | "done" | "rejected" = "running",
		sandboxId?: string,
		traceId?: string,
		rootStage?: string,
	): IssueComment {
		return this.add(BOT, `status\n\n${renderMarker("status", { runId, traceId, rootStage, stage: "triage", state, sandboxId })}`);
	}

	asClient(): GitHubClient {
		return this as unknown as GitHubClient;
	}
}

class FakeRuns {
	cancelled: string[] = [];
	constructor(public statuses: Record<string, string> = {}) {}
	getTaskRun = vi.fn(async (id: string) => {
		const status = this.statuses[id];
		if (!status) throw new Error(`task run ${id} not found`);
		return { status };
	});
	cancelTaskRun = vi.fn(async (id: string) => {
		this.cancelled.push(id);
		this.statuses[id] = "canceled";
	});
	terminated: string[] = [];
	terminateSandbox = vi.fn(async (id: string) => {
		this.terminated.push(id);
	});
}

const subject = { kind: "issue" as const, number: 12 };

beforeEach(() => {
	events.length = 0;
});

describe("takeOver", () => {
	it("cancels an active previous run, terminates its sandbox, and records the new run in the same comment", async () => {
		const gh = new FakeGitHub();
		const existing = gh.addStatus("trn-old", "running", "sbx-old");
		const runs = new FakeRuns({ "trn-old": "running" });
		const result = await takeOver({
			gh,
			repo: REPO.fullName,
			subject,
			task: "triage",
			title: "Triage",
			traceId: "trn-new",
			runId: "trn-new",
			runs,
		});
		expect(runs.cancelled).toEqual(["trn-old"]);
		expect(runs.terminated).toEqual(["sbx-old"]);
		// The stopped run is killed before it can record how it ended, so the takeover records it.
		expect(events).toContainEqual({
			traceId: "trn-old",
			runId: "trn-old",
			repo: REPO.fullName,
			subject: "issue#12",
			type: "run.finished",
			payload: { stage: "triage", state: "cancelled", outcome: "superseded", stoppedBy: "trn-new" },
		});
		expect(result).toEqual({ acquired: true, commentId: existing.id, previousRunId: "trn-old", cancelledPrevious: true });
		expect(gh.comments).toHaveLength(1);
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")).toMatchObject({ runId: "trn-new", state: "running", stage: "triage" });
		expect(gh.comments[0]?.body).toContain("is running (run `trn-new`)");
		expect(gh.labels.has(WORKING_LABEL)).toBe(true);
	});

	it("cancels the previous root when the recorded task was its child", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-child-old", "running", "sbx-old", "trn-root-old");
		const runs = new FakeRuns({ "trn-root-old": "running" });
		await takeOver({
			gh,
			repo: REPO.fullName,
			subject,
			task: "triage",
			title: "Triage",
			traceId: "trn-root-new",
			runId: "trn-child-new",
			runs,
		});

		expect(runs.cancelled).toEqual(["trn-root-old"]);
		expect(events).toContainEqual(
			expect.objectContaining({ traceId: "trn-root-old", runId: "trn-child-old", payload: expect.objectContaining({ outcome: "superseded" }) }),
		);
	});

	it("moves to another child of the same root without cancelling the parent", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-triage", "done", undefined, "trn-root", "autopilot");
		const runs = new FakeRuns({ "trn-root": "running" });
		await takeOver({
			gh,
			repo: REPO.fullName,
			subject,
			task: "spec-to-pr",
			title: "Spec-to-PR",
			traceId: "trn-root",
			runId: "trn-spec",
			runs,
		});

		expect(runs.getTaskRun).not.toHaveBeenCalled();
		expect(runs.cancelled).toEqual([]);
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")).toMatchObject({
			traceId: "trn-root",
			rootStage: "autopilot",
			runId: "trn-spec",
			stage: "spec-to-pr",
		});
	});

	it("refuses a late child instead of taking over from a newer root", async () => {
		const gh = new FakeGitHub();
		const existing = gh.addStatus("trn-new-child", "running", undefined, "trn-new-root");
		const runs = new FakeRuns({ "trn-new-root": "running" });
		const result = await takeOver({
			gh,
			repo: REPO.fullName,
			subject,
			task: "spec-to-pr",
			title: "Spec-to-PR",
			traceId: "trn-old-root",
			runId: "trn-late-child",
			mode: "continue",
			runs,
		});

		expect(result).toEqual({ acquired: false, commentId: existing.id, previousRunId: "trn-new-child", cancelledPrevious: false });
		expect(runs.getTaskRun).not.toHaveBeenCalled();
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")).toMatchObject({ traceId: "trn-new-root", runId: "trn-new-child" });
	});
});
describe("setStatus and finishStatus", () => {
	it("never overwrites a newer run's status", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-new");
		gh.labels.add(WORKING_LABEL);
		expect(await finishStatus({ gh, number: 12, runId: "trn-old", task: "triage", title: "Triage", state: "failed", summary: "x" })).toBe(false);
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")?.runId).toBe("trn-new");
		expect(gh.labels.has(WORKING_LABEL)).toBe(true);
	});

	it("keeps the working label between child stages and removes it when the root finishes", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-child", "running", undefined, "trn-root");
		gh.labels.add(WORKING_LABEL);

		await finishStatus({
			gh,
			number: 12,
			traceId: "trn-root",
			runId: "trn-child",
			task: "triage",
			title: "Triage",
			state: "done",
			summary: "done",
		});
		expect(gh.labels.has(WORKING_LABEL)).toBe(true);

		await finishStatus({
			gh,
			number: 12,
			traceId: "trn-root",
			runId: "trn-root",
			task: "autopilot",
			title: "Autopilot",
			state: "done",
			summary: "complete",
		});
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
	});
});

describe("withClaim", () => {
	const ctx = { metadata: { taskRunId: "trn-run", rootTaskRunId: "trn-root" } };

	it("rejects an actor without permission before taking over", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { reader: "read" };
		const runs = new FakeRuns();
		const fn = vi.fn();
		const outcome = await withClaim(ctx, { repo: REPO, subject, task: "triage", title: "Triage", actor: "reader", gh: gh.asClient(), runs }, fn);
		expect(fn).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ state: "rejected", outcome: "permission_denied", traceId: "trn-root", runId: "trn-run" });
		expect(gh.comments[0]?.body).toContain("did not run: @reader needs `write` permission");
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")?.state).toBe("rejected");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(events).toMatchObject([{ type: "run.finished", traceId: "trn-root", runId: "trn-run", payload: { state: "rejected" } }]);
	});

	it("runs the work and records events with the trace id and outcome", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { maintainer: "maintain" };
		gh.addStatus("trn-prev");
		const runs = new FakeRuns({ "trn-prev": "running" });
		const outcome = await withClaim(
			ctx,
			{ repo: REPO, subject, task: "triage", title: "Triage", actor: "maintainer", gh: gh.asClient(), runs },
			async (run) => {
				expect(run.runId).toBe("trn-run");
				expect(gh.labels.has(WORKING_LABEL)).toBe(true);
				await run.recordSandbox({ id: "sbx-run" } as never);
				expect(parseMarker(gh.comments[0]?.body ?? "", "status")).toMatchObject({ runId: "trn-run", state: "running", sandboxId: "sbx-run" });
				await run.progress("reading the issue");
				return { outcome: "asked-questions", summary: "asked 2 questions" };
			},
		);
		expect(runs.cancelled).toEqual(["trn-prev"]);
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")?.sandboxId).toBeUndefined();
		expect(outcome).toEqual({ state: "done", outcome: "asked-questions", summary: "asked 2 questions", traceId: "trn-root", runId: "trn-run" });
		expect(gh.comments).toHaveLength(1);
		expect(gh.comments[0]?.body).toContain("**Triage** finished: asked 2 questions");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(events).toMatchObject([
			{ type: "run.finished", traceId: "trn-prev", payload: { state: "cancelled", outcome: "superseded", stoppedBy: "trn-run" } },
			{
				type: "run.finished",
				traceId: "trn-root",
				runId: "trn-run",
				repo: REPO.fullName,
				subject: "issue#12",
				payload: { stage: "triage", state: "done", outcome: "asked-questions" },
			},
		]);
	});

	it("stops at a checkpoint after a newer run claims the subject", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { w: "write" };
		const body = vi.fn(async (run: import("../app/claims/index.js").Claim) => {
			gh.addStatus("trn-new");
			await run.progress("doing expensive work");
			return { outcome: "done", summary: "done" };
		});
		const outcome = await withClaim(
			ctx,
			{ repo: REPO, subject, task: "triage", title: "Triage", actor: "w", gh: gh.asClient(), runs: new FakeRuns() },
			body,
		);
		expect(outcome).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect((await readStatus(gh, 12))?.data.runId).toBe("trn-new");
		expect(events.at(-1)).toMatchObject({ type: "run.finished", payload: { state: "cancelled", outcome: "superseded" } });
	});

	it("records an unexpected error without leaking it, removes the label, and rethrows", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { w: "write" };
		const boom = new Error("connect ECONNREFUSED token=ghs_secret");
		await expect(
			withClaim(ctx, { repo: REPO, subject, task: "triage", title: "Triage", actor: "w", gh: gh.asClient(), runs: new FakeRuns() }, async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
		const body = gh.comments[0]?.body ?? "";
		expect(body).toContain("**Triage** failed: something went wrong");
		expect(body).not.toContain("ghs_secret");
		expect(body).not.toContain("ECONNREFUSED");
		expect(parseMarker(body, "status")?.state).toBe("failed");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "run.finished", payload: { state: "failed", outcome: "error" } });
	});

	it("reports a model-side agent stop on GitHub, but fails the task for a platform-side agent error", async () => {
		const run = (error: Error) => {
			const gh = new FakeGitHub();
			gh.permissions = { w: "write" };
			const outcome = withClaim(
				ctx,
				{ repo: REPO, subject, task: "triage", title: "Triage", actor: "w", gh: gh.asClient(), runs: new FakeRuns() },
				async () => {
					throw error;
				},
			);
			return { gh, outcome };
		};

		const stopped = run(new AgentError("triage", "max_turns", "turn limit (40) after reading /secret/path"));
		expect(await stopped.outcome).toMatchObject({ state: "failed", outcome: "agent_stopped" });
		const body = stopped.gh.comments[0]?.body ?? "";
		expect(body).toContain("the triage agent ran out of turns");
		expect(body).not.toContain("/secret/path");

		const lost = new AgentError("triage", "runner_lost", "the runner ended without a result");
		await expect(run(lost).outcome).rejects.toBe(lost);
	});
});
