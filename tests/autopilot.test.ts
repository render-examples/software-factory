import type { TaskContext } from "@renderinc/sdk/workflows";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../app/config/index.js";
import type { Db } from "../app/db/index.js";
import type { TaskResult } from "../app/runs/index.js";
import { type AutopilotDeps, runAutopilot } from "../app/workflows/autopilot/index.js";
import type { SpecToPrHandoff } from "../app/workflows/spec-to-pr/index.js";
import type { TriageHandoff } from "../app/workflows/triage/spec.js";
import { REPO } from "./fixtures/config.js";
import { pgliteDb, resetDb } from "./helpers/db.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { runRow, startRun } from "./helpers/runs.js";

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

let gh: FakeGitHub;
const run = (stages: Omit<AutopilotDeps, "gh" | "db">, extra: { commentId?: number } = {}) =>
	runAutopilot(ctx, { ...input, ...extra }, { gh: gh.asClient(), db, ...stages });

let db: Db;
beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
beforeEach(async () => {
	await resetDb(db);
	gh = new FakeGitHub();
	gh.labels(12).add(config.labels.autopilot);
});

describe("autopilot", () => {
	it("runs Triage, Spec-to-PR, and PR Reviewer in order", async () => {
		const order: string[] = [];
		const output = await run({
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
				expect(stageInput).toMatchObject({ pr: 34, headSha: "a".repeat(40), issue: 12 });
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
		expect(gh.labels(12)).not.toContain(config.labels.autopilot);
		expect(await runRow(db, "trn-autopilot")).toMatchObject({ state: "done", outcome: "completed" });
	});

	it.each(["asked", "skipped"])("waits for a reply when its resumed Triage %s", async (outcome) => {
		const specToPr = vi.fn();
		const output = await run(
			{
				triage: async (stageInput) => {
					expect(stageInput.commentId).toBe(99);
					return result("trn-triage", outcome, { summary: `${outcome}.` });
				},
				specToPr,
			},
			{ commentId: 99 },
		);

		expect(output).toMatchObject({ state: "done", outcome: "waiting_for_answers", summary: `${outcome}.` });
		expect(await runRow(db, "trn-autopilot")).toMatchObject({ outcome: "waiting_for_answers", waiting: "reply" });
		expect(gh.labels(12)).toContain(config.labels.autopilot);
		expect(specToPr).not.toHaveBeenCalled();
	});

	it("stops after a terminal stage result and removes the autopilot label", async () => {
		const prReview = vi.fn();
		const output = await run({
			triage: async () =>
				result<TriageHandoff>("trn-triage", "unchanged", {
					data: { kind: "spec", commentId: 100, hash: SPEC_HASH, version: 2 },
				}),
			specToPr: async () => result<SpecToPrHandoff>("trn-spec", "verification_failed", { state: "failed", summary: "verification failed." }),
			prReview,
		});

		expect(output).toMatchObject({ state: "failed", outcome: "stopped_at_spec_to_pr", summary: "verification failed." });
		expect(gh.labels(12)).not.toContain(config.labels.autopilot);
		expect(prReview).not.toHaveBeenCalled();
	});

	it.each([
		{ stage: "asks a question", triage: result<TriageHandoff>("trn-triage", "asked", { summary: "asked one question." }) },
		{ stage: "is superseded", triage: result<TriageHandoff>("trn-triage", "superseded", { state: "cancelled", summary: "a newer run took over." }) },
	])("stops without waiting or starting another stage when a newer run takes over and Triage $stage", async ({ triage }) => {
		const specToPr = vi.fn();
		const output = await run({
			triage: async () => {
				await startRun(db, REPO, { kind: "issue", number: 12 }, { traceId: "trn-new-autopilot" });
				return triage;
			},
			specToPr,
		});

		expect(output).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(await runRow(db, "trn-autopilot")).toMatchObject({ state: "cancelled", waiting: null });
		expect(gh.labels(12)).not.toContain(config.labels.autopilot);
		expect(specToPr).not.toHaveBeenCalled();
	});

	it("stops when a child rejects the actor's permission", async () => {
		const prReview = vi.fn();
		const output = await run({
			triage: async () =>
				result<TriageHandoff>("trn-triage", "drafted", {
					data: { kind: "spec", commentId: 100, hash: SPEC_HASH, version: 1 },
				}),
			specToPr: async () => result<SpecToPrHandoff>("trn-spec", "permission_denied", { state: "rejected" }),
			prReview,
		});

		expect(output).toMatchObject({ state: "failed", outcome: "stopped_at_spec_to_pr" });
		expect(gh.labels(12)).not.toContain(config.labels.autopilot);
		expect(gh.labels(12)).not.toContain(config.labels.specApproved);
		expect(prReview).not.toHaveBeenCalled();
	});

	it("removes the autopilot label and rethrows an unexpected stage error", async () => {
		await expect(
			run({
				triage: async () => {
					throw new Error("task transport failed");
				},
			}),
		).rejects.toThrow("task transport failed");
		expect(gh.labels(12)).not.toContain(config.labels.autopilot);
		expect(await runRow(db, "trn-autopilot")).toMatchObject({ state: "failed", outcome: "error" });
	});
});
