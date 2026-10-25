import type { TaskContext } from "@renderinc/sdk/workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskResult } from "../app/claims/index.js";
import type { FactoryEvent } from "../app/events/index.js";
import type { GitHubClient, IssueComment } from "../app/github/index.js";
import { renderMarker } from "../app/github/index.js";
import type { SpecToPrHandoff } from "../app/workflows/spec-to-pr/index.js";
import type { TriageHandoff } from "../app/workflows/triage/spec.js";

const events: FactoryEvent[] = [];
vi.mock("../app/events/index.js", () => ({
	emit: (event: FactoryEvent) => {
		events.push(event);
	},
}));

const { config } = await import("../app/config/index.js");
const { runAutopilot } = await import("../app/workflows/autopilot/index.js");
const { triageWorkflow } = await import("../app/workflows/triage/index.js");
const { specToPrWorkflow } = await import("../app/workflows/spec-to-pr/index.js");
const { prReviewWorkflow } = await import("../app/workflows/pr-review/index.js");

const REPO = Object.keys(config.repos)[0];
if (!REPO) throw new Error("factory.config.ts must configure at least one repository");
const SPEC_HASH = "b".repeat(64);

const input = { repo: REPO, installationId: 5, issue: 12, actor: "maintainer" };
const ctx = {
	metadata: { taskRunId: "trn-autopilot", rootTaskRunId: "trn-autopilot" },
	run: vi.fn(() => {
		throw new Error("test did not inject a stage");
	}),
} as unknown as Pick<TaskContext, "metadata" | "run">;

const result = <Data>(runId: string, outcome: string, overrides: Partial<TaskResult<Data>> = {}): TaskResult<Data> => ({
	state: "done",
	outcome,
	summary: outcome,
	traceId: "trn-autopilot",
	runId,
	...overrides,
});

class FakeGitHub {
	readonly labels = new Map<number, Set<string>>([[12, new Set([config.labels.autopilot])]]);
	readonly comments: IssueComment[] = [];
	private nextId = 1;

	botLogin = async () => "software-factory[bot]";
	listIssueComments = async (_number: number) => this.comments.map((comment) => ({ ...comment }));
	createComment = async (number: number, body: string) => {
		const comment: IssueComment = {
			id: this.nextId++,
			body,
			author: { login: "software-factory[bot]", type: "Bot" },
			createdAt: "2026-10-25T11:00:00Z",
			updatedAt: "2026-10-25T11:00:00Z",
			htmlUrl: `https://github.test/issues/${number}#issuecomment-${this.nextId}`,
		};
		this.comments.push(comment);
		return { ...comment };
	};
	updateComment = async (id: number, body: string) => {
		const comment = this.comments.find((candidate) => candidate.id === id);
		if (!comment) throw new Error(`missing comment ${id}`);
		comment.body = body;
		return { ...comment };
	};
	ensureLabel = async () => {};
	addLabels = async (number: number, labels: readonly string[]) => {
		const current = this.labels.get(number) ?? new Set<string>();
		this.labels.set(number, current);
		for (const label of labels) current.add(label);
	};
	getIssue = async (number: number) => ({
		number,
		title: "Autopilot issue",
		body: "Build the feature.",
		state: "open",
		labels: [...(this.labels.get(number) ?? [])],
		author: { login: "reporter", type: "User" },
		isPull: false,
		htmlUrl: `https://github.test/issues/${number}`,
	});
	getPermission = async () => "write" as const;
	removeLabel = async (number: number, label: string) => {
		this.labels.get(number)?.delete(label);
	};

	replaceOwner(traceId: string) {
		const comment = this.comments[0];
		if (!comment) throw new Error("status comment does not exist");
		comment.body = renderMarker("status", { runId: `${traceId}-child`, traceId, stage: "triage", title: "Triage", state: "running" });
	}
}

const asClient = (gh: FakeGitHub) => gh as unknown as GitHubClient;

beforeEach(() => {
	events.length = 0;
});

describe("autopilot", () => {
	it("runs the registered GitHub task definitions as Workflows children", async () => {
		const gh = new FakeGitHub();
		const names: string[] = [];
		const workflowCtx = {
			metadata: ctx.metadata,
			run: vi.fn(async (definition: { name: string }, stageInput: unknown) => {
				names.push(definition.name);
				if (definition.name === "triage") {
					return result<TriageHandoff>("trn-triage", "drafted", {
						data: { kind: "spec", commentId: 100, hash: SPEC_HASH, version: 1 },
					});
				}
				if (definition.name === "spec-to-pr") {
					expect(stageInput).toMatchObject({
						approval: { kind: "autopilot", commentId: 100, hash: SPEC_HASH, version: 1 },
					});
					return result<SpecToPrHandoff>("trn-spec", "pr_opened", {
						data: { kind: "pull_request", pr: 34, headSha: "a".repeat(40) },
					});
				}
				expect(stageInput).toMatchObject({ pr: 34, workflowIssue: 12 });
				return result("trn-review", "reviewed");
			}),
		} as unknown as Pick<TaskContext, "metadata" | "run">;

		const output = await runAutopilot(workflowCtx, input, { gh: asClient(gh) });
		expect(names).toEqual(["triage", "spec-to-pr", "pr-review"]);
		expect(output.outcome).toBe("completed");
	});

	it("runs Triage, Spec-to-PR, and PR Reviewer in order", async () => {
		const gh = new FakeGitHub();
		const order: string[] = [];
		const output = await runAutopilot(ctx, input, {
			gh: asClient(gh),
			triage: async () => {
				order.push("triage");
				return result<TriageHandoff>("trn-triage", "drafted", {
					data: { kind: "spec", commentId: 100, hash: SPEC_HASH, version: 1 },
				});
			},
			specToPr: async (stageInput) => {
				order.push("spec-to-pr");
				expect(stageInput.approval).toEqual({ kind: "autopilot", commentId: 100, hash: SPEC_HASH, version: 1 });
				return result<SpecToPrHandoff>("trn-spec", "pr_opened", {
					data: { kind: "pull_request", pr: 34, headSha: "a".repeat(40) },
				});
			},
			prReview: async (stageInput) => {
				order.push("pr-review");
				expect(stageInput).toMatchObject({ pr: 34, headSha: "a".repeat(40), workflowIssue: 12 });
				return result("trn-review", "reviewed");
			},
		});

		expect(order).toEqual(["triage", "spec-to-pr", "pr-review"]);
		expect(output).toMatchObject({ state: "done", outcome: "completed", summary: "opened and reviewed draft PR #34." });
		expect(output.data?.stages.map((stage) => [stage.task, stage.runId])).toEqual([
			["triage", "trn-triage"],
			["spec-to-pr", "trn-spec"],
			["pr-review", "trn-review"],
		]);
		expect(gh.labels.get(12)).not.toContain(config.labels.autopilot);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "run.finished", payload: expect.objectContaining({ stage: "autopilot", outcome: "completed" }) }),
		);
	});

	it("keeps the autopilot label while Triage waits for answers", async () => {
		const gh = new FakeGitHub();
		const specToPr = vi.fn();
		const output = await runAutopilot(
			ctx,
			{ ...input, commentId: 99 },
			{
				gh: asClient(gh),
				triage: async (stageInput) => {
					expect(stageInput.commentId).toBe(99);
					return result("trn-triage", "asked", { summary: "asked one question." });
				},
				specToPr,
			},
		);

		expect(output).toMatchObject({ state: "done", outcome: "waiting_for_answers" });
		expect(gh.labels.get(12)).toContain(config.labels.autopilot);
		expect(specToPr).not.toHaveBeenCalled();
	});

	it("stops after a terminal stage result and removes the autopilot label", async () => {
		const gh = new FakeGitHub();
		const prReview = vi.fn();
		const output = await runAutopilot(ctx, input, {
			gh: asClient(gh),
			triage: async () =>
				result<TriageHandoff>("trn-triage", "unchanged", {
					data: { kind: "spec", commentId: 100, hash: SPEC_HASH, version: 2 },
				}),
			specToPr: async () => result<SpecToPrHandoff>("trn-spec", "verification_failed", { state: "failed", summary: "verification failed." }),
			prReview,
		});

		expect(output).toMatchObject({ state: "failed", outcome: "stopped_at_spec_to_pr", summary: "verification failed." });
		expect(gh.labels.get(12)).not.toContain(config.labels.autopilot);
		expect(prReview).not.toHaveBeenCalled();
	});

	it("does not start another stage after the current one is superseded", async () => {
		const gh = new FakeGitHub();
		const specToPr = vi.fn();
		const output = await runAutopilot(ctx, input, {
			gh: asClient(gh),
			triage: async () => {
				gh.replaceOwner("trn-new-autopilot");
				return result("trn-triage", "superseded", { state: "cancelled", summary: "a newer run took over." });
			},
			specToPr,
		});

		expect(output).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(gh.labels.get(12)).not.toContain(config.labels.autopilot);
		expect(specToPr).not.toHaveBeenCalled();
	});

	it("stops when a child rejects the actor's permission", async () => {
		const gh = new FakeGitHub();
		const prReview = vi.fn();
		const output = await runAutopilot(ctx, input, {
			gh: asClient(gh),
			triage: async () =>
				result<TriageHandoff>("trn-triage", "drafted", {
					data: { kind: "spec", commentId: 100, hash: SPEC_HASH, version: 1 },
				}),
			specToPr: async () => result<SpecToPrHandoff>("trn-spec", "permission_denied", { state: "rejected" }),
			prReview,
		});

		expect(output).toMatchObject({ state: "failed", outcome: "stopped_at_spec_to_pr" });
		expect(gh.labels.get(12)).not.toContain(config.labels.autopilot);
		expect(gh.labels.get(12)).not.toContain(config.labels.specApproved);
		expect(prReview).not.toHaveBeenCalled();
	});

	it("removes the autopilot label and rethrows an unexpected stage error", async () => {
		const gh = new FakeGitHub();
		await expect(
			runAutopilot(ctx, input, {
				gh: asClient(gh),
				triage: async () => {
					throw new Error("task transport failed");
				},
			}),
		).rejects.toThrow("task transport failed");
		expect(gh.labels.get(12)).not.toContain(config.labels.autopilot);
		expect(events).toContainEqual(expect.objectContaining({ type: "run.finished", payload: expect.objectContaining({ outcome: "error" }) }));
	});
});

describe("GitHub task authoring", () => {
	it("exposes a direct runner and a registered subtask definition", () => {
		expect(triageWorkflow.task.name).toBe("triage");
		expect(specToPrWorkflow.task.name).toBe("spec-to-pr");
		expect(prReviewWorkflow.task.name).toBe("pr-review");
		expect(typeof triageWorkflow.run).toBe("function");
	});
});
