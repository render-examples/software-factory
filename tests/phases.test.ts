import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "../app/events/index.js";

const events: FactoryEvent[] = [];
vi.mock("../app/events/index.js", () => ({
	emit: async (event: FactoryEvent) => {
		events.push(event);
	},
}));

const { AgentError } = await import("../app/agents/index.js");
const { config, requireRepo } = await import("../app/config/index.js");
const { renderMarker, parseMarker } = await import("../app/github/index.js");
type GitHubClient = import("../app/github/index.js").GitHubClient;
type IssueComment = import("../app/github/index.js").IssueComment;
type Permission = import("../app/github/index.js").Permission;
const {
	Budget,
	checkPermission,
	finishStatus,
	PhaseError,
	permissionAtLeast,
	readStatus,
	setStatus,
	takeOver,
	traceIds,
	WORKING_LABEL,
	withPhase,
} = await import("../app/phases/index.js");

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

const subject = { kind: "issue" as const, number: 12 };

beforeEach(() => {
	events.length = 0;
});

describe("permissions", () => {
	it("ranks none < read < triage < write < maintain < admin", () => {
		const order: Permission[] = ["none", "read", "triage", "write", "maintain", "admin"];
		for (const [i, have] of order.entries()) {
			for (const [j, need] of order.entries()) expect(permissionAtLeast(have, need)).toBe(i >= j);
		}
	});

	it("checks the actor against config.minimumPermission (write)", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { t: "triage", w: "write", a: "admin" };
		expect(await checkPermission(gh, "t")).toBe(false);
		expect(await checkPermission(gh, "w")).toBe(true);
		expect(await checkPermission(gh, "a")).toBe(true);
		expect(await checkPermission(gh, "nobody")).toBe(false);
	});
});

describe("traceIds", () => {
	it("uses the root run as the trace and this run as the run", () => {
		expect(traceIds({ metadata: { taskRunId: "trn-2", rootTaskRunId: "trn-1" } })).toEqual({ traceId: "trn-1", runId: "trn-2" });
		expect(traceIds({ metadata: { taskRunId: "trn-2" } })).toEqual({ traceId: "trn-2", runId: "trn-2" });
		const local = traceIds({ metadata: {} });
		expect(local.runId).toBeUndefined();
		expect(local.traceId).toMatch(/^[0-9a-f-]{36}$/);
	});
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

	it("leaves a finished previous run alone", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-old", "done");
		const runs = new FakeRuns({ "trn-old": "succeeded" });
		const result = await takeOver({ gh, subject, phase: "triage", runId: "trn-new", runs });
		expect(runs.cancelTaskRun).not.toHaveBeenCalled();
		expect(result.cancelledPrevious).toBe(false);
		expect((await readStatus(gh, 12))?.data.runId).toBe("trn-new");
	});

	it("treats a run the API can't find as finished", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-gone");
		const runs = new FakeRuns();
		expect((await takeOver({ gh, subject, phase: "triage", runId: "trn-new", runs })).cancelledPrevious).toBe(false);
	});

	it("creates the status comment when there is none, ignoring forged markers", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-forged", "running", "mallory");
		const runs = new FakeRuns({ "trn-forged": "running" });
		await takeOver({ gh, subject, phase: "triage", runId: "trn-new", runs });
		expect(runs.getTaskRun).not.toHaveBeenCalled();
		expect(gh.comments).toHaveLength(2);
		expect((await readStatus(gh, 12))?.data.runId).toBe("trn-new");
	});

	it("doesn't look up its own run on a retry", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-1");
		const runs = new FakeRuns();
		await takeOver({ gh, subject, phase: "triage", runId: "trn-1", runs });
		expect(runs.getTaskRun).not.toHaveBeenCalled();
	});

	it("throws when the previous run can't be cancelled and is still running", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-old");
		const runs = new FakeRuns({ "trn-old": "running" });
		runs.cancelTaskRun.mockRejectedValueOnce(new Error("503"));
		await expect(takeOver({ gh, subject, phase: "triage", runId: "trn-new", runs })).rejects.toThrow("503");
		expect((await readStatus(gh, 12))?.data.runId).toBe("trn-old");
	});
});

describe("setStatus and finishStatus", () => {
	it("updates the same status comment and removes the working label", async () => {
		const gh = new FakeGitHub();
		await takeOver({ gh, subject, phase: "triage", runId: "trn-1", runs: new FakeRuns() });
		const id = gh.comments[0]?.id;
		await setStatus({ gh, number: 12, runId: "trn-1", phase: "triage", state: "running", summary: "drafting the spec" });
		expect(gh.comments[0]?.body).toContain("drafting the spec");
		const wrote = await finishStatus({
			gh,
			number: 12,
			runId: "trn-1",
			phase: "triage",
			state: "done",
			summary: "asked 2 questions",
			links: [{ label: "Questions", url: "https://github.test/c/1" }],
		});
		expect(wrote).toBe(true);
		expect(gh.comments).toHaveLength(1);
		expect(gh.comments[0]?.id).toBe(id);
		expect(gh.comments[0]?.body).toMatch(/^\*\*Triage\*\* finished: asked 2 questions/);
		expect(gh.comments[0]?.body).toContain("- [Questions](https://github.test/c/1)");
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")).toMatchObject({ runId: "trn-1", state: "done" });
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
	});

	it("never overwrites a newer run's status", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-new");
		gh.labels.add(WORKING_LABEL);
		expect(await finishStatus({ gh, number: 12, runId: "trn-old", phase: "triage", state: "failed", summary: "x" })).toBe(false);
		expect(parseMarker(gh.comments[0]?.body ?? "", "status")?.runId).toBe("trn-new");
		expect(gh.labels.has(WORKING_LABEL)).toBe(true);
	});

	it("doesn't let a rejected trigger overwrite a real run's record, but reuses a rejected one", async () => {
		const gh = new FakeGitHub();
		gh.addStatus("trn-real", "done");
		expect(await setStatus({ gh, number: 12, runId: "trn-r1", phase: "triage", state: "rejected", summary: "no" })).toBe(false);

		const fresh = new FakeGitHub();
		fresh.addStatus("trn-r1", "rejected");
		expect(await setStatus({ gh: fresh, number: 12, runId: "trn-r2", phase: "triage", state: "rejected", summary: "no" })).toBe(true);
		expect(fresh.comments).toHaveLength(1);
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
		const outcome = await withPhase(
			ctx,
			{ repo: REPO, subject, phase: "triage", actor: "maintainer", gh: gh.asClient(), runs },
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
		expect(outcome).toEqual({ state: "done", outcome: "asked-questions", summary: "asked 2 questions", traceId: "trn-root", runId: "trn-run" });
		expect(gh.comments).toHaveLength(1);
		expect(gh.comments[0]?.body).toContain("**Triage** finished: asked 2 questions");
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(events).toMatchObject([
			{ type: "run.started", traceId: "trn-root", runId: "trn-run", repo: REPO.fullName, subject: "issue#12", payload: { phase: "triage", actor: "maintainer" } },
			{ type: "run.finished", traceId: "trn-root", payload: { state: "done", outcome: "asked-questions", costUsd: 0.42 } },
		]);
	});

	it("records an expected PhaseError as failed without failing the task", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { w: "write" };
		const outcome = await withPhase(ctx, { repo: REPO, subject, phase: "spec-to-pr", actor: "w", gh: gh.asClient(), runs: new FakeRuns() }, async (run) => {
			await run.budget.track(async () => ({ costUsd: 1.25 }));
			throw new PhaseError("verify failed after 2 repair rounds.", "verify-failed");
		});
		expect(outcome).toMatchObject({ state: "failed", outcome: "verify-failed" });
		expect(events.at(-1)?.payload).toMatchObject({ state: "failed", outcome: "verify-failed", costUsd: 1.25 });
		expect(gh.comments[0]?.body).toContain("**Spec-to-PR** failed: verify failed after 2 repair rounds.");
	});

	it("records an unexpected error without leaking it, removes the label, and rethrows", async () => {
		const gh = new FakeGitHub();
		gh.permissions = { w: "write" };
		const boom = new Error("connect ECONNREFUSED token=ghs_secret");
		await expect(
			withPhase(ctx, { repo: REPO, subject, phase: "triage", actor: "w", gh: gh.asClient(), runs: new FakeRuns() }, async (run) => {
				await run.budget.track(async () => {
					throw new AgentError("agent_error", "model error", USAGE, 0.3, 1);
				}).catch(() => undefined);
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

describe("Budget", () => {
	it("passes down what's left, never below zero, and counts each call's spend", async () => {
		const budget = new Budget(10);
		const given: number[] = [];
		await budget.track(async (usd) => {
			given.push(usd);
			return { costUsd: 4 };
		});
		await budget.track(async (usd) => {
			given.push(usd);
			return { costUsd: 7 };
		});
		await budget.track(async (usd) => {
			given.push(usd);
			return { costUsd: 0 };
		});
		expect(given).toEqual([10, 6, 0]);
		expect(budget.spent).toBe(11);
		expect(budget.remaining).toBe(0);
	});

	it("counts a failed call's partial cost from AgentError, and nothing for other errors", async () => {
		const budget = new Budget(10);
		const failed = new AgentError("timeout", "timed out", USAGE, 2.5, 3);
		await expect(budget.track(async () => Promise.reject(failed))).rejects.toBe(failed);
		await expect(budget.track(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		expect(budget.spent).toBe(2.5);
	});

	it("gives parallel calls equal shares of what's left, then counts what they actually spent", async () => {
		const budget = new Budget(10);
		const given: number[] = [];
		const call = (cost: number) => async (usd: number) => {
			given.push(usd);
			await Promise.resolve();
			return { costUsd: cost };
		};
		await Promise.all([budget.track(call(1), { shareOf: 5 }), budget.track(call(3), { shareOf: 5 })]);
		expect(given).toEqual([2, 2]);
		expect(budget.spent).toBe(4);
		expect(budget.remaining).toBe(6);
	});
});
