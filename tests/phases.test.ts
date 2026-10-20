import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "../app/events/index.js";

const events: FactoryEvent[] = [];
vi.mock("../app/events/index.js", () => ({
	emit: async (event: FactoryEvent) => {
		events.push(event);
	},
	claimRun: async (input: { runId: string; repo: string; subject: string }) => ({ id: "1", ...input }),
	isCurrentRun: async () => true,
}));

const { AgentError } = await import("../app/agents/index.js");
const { config, requireRepo } = await import("../app/config/index.js");
const { renderMarker, parseMarker } = await import("../app/github/index.js");
type GitHubClient = import("../app/github/index.js").GitHubClient;
type IssueComment = import("../app/github/index.js").IssueComment;
type Permission = import("../app/github/index.js").Permission;
const { finishStatus, readStatus, takeOver, WORKING_LABEL, withPhase } = await import("../app/phases/index.js");

const BOT = "software-factory[bot]";
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
const REPO = requireRepo("render-examples/render-factory-example-target", 5);

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
			performedViaApp: null,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			htmlUrl: "",
		};
		this.comments.push(comment);
		return { ...comment };
	}

	addStatus(runId: string, state: "running" | "done" | "rejected" = "running", login = BOT): IssueComment {
		return this.add(login, `status\n\n${renderMarker("status", { runId, phase: "triage", state })}`);
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
}

class FakeCoordination {
	current = true;
	private nextId = 1;
	claim = vi.fn(async (input: { runId: string; repo: string; subject: string }) => ({
		id: String(this.nextId++),
		...input,
	}));
	isCurrent = vi.fn(async () => this.current);
}

const subject = { kind: "issue" as const, number: 12 };

beforeEach(() => {
	events.length = 0;
});

describe("takeOver", () => {
	it("cancels an active previous run and records the new run in the same comment", async () => {
		const gh = new FakeGitHub();
		const existing = gh.addStatus("trn-old");
		const runs = new FakeRuns({ "trn-old": "running" });
		const result = await takeOver({ gh, subject, phase: "triage", runId: "trn-new", runs });
		expect(runs.cancelled).toEqual(["trn-old"]);
		expect(result).toEqual({ commentId: existing.id, previousRunId: "trn-old", cancelledPrevious: true });
		expect(gh.comments).toHaveLength(1);
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")).toMatchObject({ runId: "trn-new", state: "running", phase: "triage" });
		expect(gh.comments[0]?.body).toContain("is running (run `trn-new`)");
		expect(gh.labels.has(WORKING_LABEL)).toBe(true);
	});
});
describe("setStatus and finishStatus", () => {
	it("never overwrites a newer run's status", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-new");
		gh.labels.add(WORKING_LABEL);
		expect(await finishStatus({ gh, number: 12, runId: "trn-old", phase: "triage", state: "failed", summary: "x" })).toBe(false);
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")?.runId).toBe("trn-new");
		expect(gh.labels.has(WORKING_LABEL)).toBe(true);
	});
});

describe("withPhase", () => {
	const ctx = { metadata: { taskRunId: "trn-run", rootTaskRunId: "trn-root" } };

	it("rejects an actor without permission before taking over", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { reader: "read" };
		const runs = new FakeRuns();
		const fn = vi.fn();
		const outcome = await withPhase(ctx, { repo: REPO, subject, phase: "triage", actor: "reader", gh: gh.asClient(), runs }, fn);
		expect(fn).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ state: "rejected", outcome: "permission-denied", traceId: "trn-root", runId: "trn-run" });
		expect(gh.comments[0]?.body).toContain("did not run: @reader needs `write` permission");
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")?.state).toBe("rejected");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(events.map((e) => e.type)).toEqual(["run.started", "run.finished"]);
		expect(events.at(-1)?.payload).toMatchObject({ state: "rejected", costUsd: 0 });
	});

	it("runs the phase and records events with the trace id, outcome, and cost", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { maintainer: "maintain" };
		gh.addStatus("trn-prev");
		const runs = new FakeRuns({ "trn-prev": "running" });
		const coordination = new FakeCoordination();
		const outcome = await withPhase(
			ctx,
			{ repo: REPO, subject, phase: "triage", actor: "maintainer", gh: gh.asClient(), runs, coordination },
			async (run) => {
				expect(run.runId).toBe("trn-run");
				expect(gh.labels.has(WORKING_LABEL)).toBe(true);
				await run.progress("reading the issue");
				expect(run.budget).toMatchObject({ limitUsd: config.limits.perRunUsd, spent: 0 });
				await run.budget.track(async () => ({ costUsd: 0.42 }));
				return { outcome: "asked-questions", summary: "asked 2 questions" };
			},
		);
		expect(runs.cancelled).toEqual(["trn-prev"]);
		expect(coordination.claim).toHaveBeenCalledWith({
			traceId: "trn-root",
			runId: "trn-run",
			repo: REPO.fullName,
			subject: "issue#12",
			phase: "triage",
			actor: "maintainer",
		});
		expect(outcome).toEqual({ state: "done", outcome: "asked-questions", summary: "asked 2 questions", traceId: "trn-root", runId: "trn-run" });
		expect(gh.comments).toHaveLength(1);
		expect(gh.comments[0]?.body).toContain("**Triage** finished: asked 2 questions");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(events).toMatchObject([
			{
				type: "run.started",
				traceId: "trn-root",
				runId: "trn-run",
				repo: REPO.fullName,
				subject: "issue#12",
				payload: { phase: "triage", actor: "maintainer" },
			},
			{ type: "run.finished", traceId: "trn-root", payload: { state: "done", outcome: "asked-questions", costUsd: 0.42 } },
		]);
	});

	it("stops at a checkpoint after a newer run claims the subject", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { w: "write" };
		const coordination = new FakeCoordination();
		const body = vi.fn(async (run: import("../app/phases/index.js").PhaseRun) => {
			gh.addStatus("trn-new");
			coordination.current = false;
			await run.progress("doing expensive work");
			return { outcome: "done", summary: "done" };
		});
		const outcome = await withPhase(
			ctx,
			{ repo: REPO, subject, phase: "triage", actor: "w", gh: gh.asClient(), runs: new FakeRuns(), coordination },
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
			withPhase(ctx, { repo: REPO, subject, phase: "triage", actor: "w", gh: gh.asClient(), runs: new FakeRuns() }, async (run) => {
				await run.budget
					.track(async () => {
						throw new AgentError("agent_error", "model error", USAGE, 0.3, 1);
					})
					.catch(() => undefined);
				throw boom;
			}),
		).rejects.toBe(boom);
		const body = gh.comments[0]?.body ?? "";
		expect(body).toContain("**Triage** failed: something went wrong");
		expect(body).not.toContain("ghs_secret");
		expect(body).not.toContain("ECONNREFUSED");
		expect(parseMarker(body, "status")?.state).toBe("failed");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "run.finished", payload: { state: "failed", outcome: "error", costUsd: 0.3 } });
	});
});
