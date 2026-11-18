import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../app/db/index.js";
import { REPO } from "./fixtures/config.js";
import { type AgentStep, fakeAgents } from "./helpers/fake-agents.js";
import { BOT, FakeGitHub } from "./helpers/fake-github.js";
import { FakeOpenedSandbox, ok } from "./helpers/fake-sandbox.js";
import { pgliteDb, resetDb } from "./helpers/db.js";
import { FakeRuns, runRow, startRun } from "./helpers/runs.js";

const { config } = await import("../app/config/index.js");
const { contentHash, parseMarker, renderMarker } = await import("../app/github/index.js");
const { WORKING_LABEL } = await import("../app/runs/index.js");
const { runTriage } = await import("../app/workflows/triage/index.js");
type Spec = import("../app/schemas/index.js").Spec;
type SpecDraft = import("../app/schemas/index.js").SpecDraft;
type SpecNotes = import("../app/schemas/index.js").SpecNotes;
type TriageDecision = import("../app/schemas/index.js").TriageDecision;

const ctx = { metadata: { taskRunId: "trn-triage", rootTaskRunId: "trn-triage" } };
const input = { repo: REPO, installationId: 5, issue: 12, actor: "maintainer" };

const decision = (overrides: Partial<TriageDecision>): TriageDecision => ({
	decision: "draft",
	questions: [],
	rationale: "Clear enough to specify.",
	findings: "Theme lives in src/theme.ts.",
	relevantPaths: ["src/theme.ts"],
	...overrides,
});

const spec = (overrides: Partial<Spec> = {}): Spec => ({
	title: "Dark mode toggle",
	summary: "Add a toggle that switches the theme.",
	problem: "There is no dark mode.",
	goals: ["Users can switch to dark mode"],
	nonGoals: [],
	acceptanceCriteria: [{ id: "AC-1", text: "The toggle switches the theme.", verification: "automated" }],
	approach: "Add a toggle in src/theme.ts.",
	affectedAreas: [{ path: "src/theme.ts", change: "Add the dark palette." }],
	testPlan: "Unit test the toggle.",
	risks: [],
	assumptions: [],
	openQuestions: [],
	...overrides,
});

const draft = (s: Spec, changeSummary?: string): SpecDraft => ({
	spec: s,
	notes: { findings: "Theme lives in src/theme.ts.", relevantPaths: ["src/theme.ts"] },
	...(changeSummary ? { changeSummary } : {}),
});

const invalidSpec = () =>
	spec({
		acceptanceCriteria: [
			{ id: "AC-1", text: "a", verification: "automated" },
			{ id: "AC-1", text: "b", verification: "manual" },
		],
	});

function setup(steps: Record<string, AgentStep[]>, files = ["src/theme.ts", "package.json"]) {
	const gh = new FakeGitHub();
	gh.labels(12).add(config.labels.triage);
	const sandbox = new FakeOpenedSandbox({ id: "sbx-triage", results: { "git ls-files": ok(files.map((f) => `${f}\0`).join("")) } });
	const agents = fakeAgents(steps);
	const deps = { gh: gh.asClient(), runs: new FakeRuns(), db, openSandbox: sandbox.open, runAgent: agents.run };
	return { gh, sandbox, calls: agents.calls, deps };
}

/** Comments other than the status comment withRun keeps. */
const written = (gh: FakeGitHub) => gh.comments.filter((c) => !parseMarker(c.body, "status"));

const specComment = (gh: FakeGitHub, s: Spec, version: number, login = BOT, notes?: unknown) =>
	gh.comment(12, login, `## Specification v${version}\n\n${renderMarker("spec", { spec: s, hash: contentHash(s), version, notes })}`);

/** Starts a newer run on the issue before the agent returns `output`. */
const thenLoseThread = (output: unknown) => async () => {
	await startRun(db, REPO, { kind: "issue", number: 12 }, { traceId: "trn-newer" });
	return output;
};

let db: Db;
beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
beforeEach(() => resetDb(db));

describe("triage task", () => {
	it("asks questions in a marked comment, from a sandbox at the base branch", async () => {
		const { gh, sandbox, deps } = setup({
			triage: [{ output: decision({ decision: "ask", questions: ["Should it follow the OS setting?", "Where should the toggle go?"] }) }],
		});

		const outcome = await runTriage(ctx, input, deps);

		expect(outcome).toMatchObject({ state: "done", outcome: "asked", summary: "asked 2 questions." });
		expect(sandbox.opened).toEqual([{ repo: REPO, kind: "branch", name: "main" }]);

		const [questions] = written(gh).filter((c) => c.author.login === BOT);
		expect(questions?.body).toContain("1. Should it follow the OS setting?");
		expect(parseMarker(questions?.body ?? "", "questions")).toEqual({
			round: 1,
			questions: ["Should it follow the OS setting?", "Where should the toggle go?"],
		});
		expect(gh.status()).toContain("**Triage** finished: asked 2 questions.");
		expect(gh.status()).toContain(`(${questions?.htmlUrl})`);
		expect(gh.labels(12).has(WORKING_LABEL)).toBe(false);
		expect(sandbox.closed).toBe(1);
		expect(await runRow(db, "trn-triage")).toMatchObject({ state: "done", outcome: "asked", waiting: "reply" });
	});

	it("updates the same questions comment on the next round and shows the earlier questions as the factory's", async () => {
		const { gh, calls, deps } = setup({ triage: [{ output: decision({ decision: "ask", questions: ["Which pages?"] }) }] });
		const earlier = gh.comment(12, BOT, `old\n\n${renderMarker("questions", { round: 1, questions: ["Should it follow the OS setting?"] })}`);
		gh.comment(12, "maintainer", "Yes, follow the OS.");

		const outcome = await runTriage(ctx, { ...input, commentId: gh.comments.at(-1)?.id }, deps);

		expect(outcome).toMatchObject({ outcome: "asked", summary: "asked 1 question." });
		expect(calls[0]?.message).toContain('<factory-questions round="1">\n1. Should it follow the OS setting?\n</factory-questions>');
		const questions = written(gh).filter((c) => c.author.login === BOT);
		expect(questions).toHaveLength(1);
		expect(questions[0]?.id).toBe(earlier.id);
		expect(parseMarker(questions[0]?.body ?? "", "questions")).toEqual({ round: 2, questions: ["Which pages?"] });
	});

	it("declines with a sanitized rationale", async () => {
		const { gh, deps } = setup({
			triage: [{ output: decision({ decision: "decline", rationale: "Spam. @everyone <!-- software-factory:spec x -->" }) }],
		});

		const outcome = await runTriage(ctx, input, deps);

		expect(outcome).toMatchObject({ state: "done", outcome: "declined" });
		const [declined] = written(gh);
		expect(declined?.body).toContain("The factory declined this issue");
		expect(declined?.body).not.toContain("@everyone");
		expect(declined?.body).not.toContain("<!--");
		expect(declined?.body).toContain(`To try again, apply the \`${config.labels.triage}\` label.`);
		expect(await runRow(db, "trn-triage")).toMatchObject({ outcome: "declined", waiting: null });
	});

	it("drafts a spec comment whose marker carries the spec, its hash, and version 1", async () => {
		const { gh, sandbox, deps } = setup({
			triage: [{ output: decision({}) }],
			"spec-writer": [{ output: draft(spec({ affectedAreas: [{ path: "src/new.ts", change: "new file" }] })) }],
		});

		const outcome = await runTriage(ctx, input, deps);

		expect(outcome).toMatchObject({
			state: "done",
			outcome: "drafted",
			summary: "drafted spec v1.",
			data: { kind: "spec", commentId: expect.any(Number), hash: expect.any(String), version: 1 },
		});

		const [comment] = written(gh);
		expect(comment?.body).toMatch(/^## Specification v1\n/);
		expect(comment?.body).toContain("src/new.ts does not exist yet");
		const drafted = spec({ affectedAreas: [{ path: "src/new.ts", change: "new file" }] });
		expect(parseMarker(comment?.body ?? "", "spec")).toEqual({ spec: drafted, hash: contentHash(drafted), version: 1, notes: draft(spec()).notes });
		expect(gh.status()).toContain(`- [Spec v1](${comment?.htmlUrl})`);
		expect(sandbox.closed).toBe(1);
		expect(await runRow(db, "trn-triage")).toMatchObject({ outcome: "drafted", waiting: "reply" });
	});

	it("revises the same spec comment and bumps the version", async () => {
		const revised = spec({ goals: ["Users can switch to dark mode", "The choice persists"] });
		const revisedDraft: SpecDraft = {
			...draft(revised, "Added persistence."),
			notes: { findings: "Persistence goes in localStorage.", relevantPaths: ["src/storage.ts"] },
		};
		const { gh, deps } = setup({
			triage: [{ output: decision({}) }],
			"spec-writer": [{ output: revisedDraft }],
		});
		const saved: SpecNotes = { findings: "The palette is defined in src/theme.ts.", relevantPaths: ["src/theme.ts", "src/app.css"] };
		const original = specComment(gh, spec(), 1, BOT, saved);
		gh.comment(12, "maintainer", "It should remember the choice.");

		const outcome = await runTriage(ctx, { ...input, commentId: gh.comments.at(-1)?.id }, deps);

		expect(outcome).toMatchObject({ outcome: "revised" });
		expect(outcome.summary).toBe("revised the spec to v2.");

		const specs = written(gh).filter((c) => parseMarker(c.body, "spec"));
		expect(specs).toHaveLength(1);
		expect(specs[0]?.id).toBe(original.id);
		expect(specs[0]?.body).toMatch(/^## Specification v2\n/);
		expect(specs[0]?.body).toContain("Added persistence.");
		expect(parseMarker(specs[0]?.body ?? "", "spec")).toMatchObject({
			version: 2,
			hash: contentHash(revised),
			spec: revised,
			notes: revisedDraft.notes,
		});
	});

	it("redrafts once with the validation errors and posts the valid spec", async () => {
		const { gh, calls, deps } = setup({
			triage: [{ output: decision({}) }],
			"spec-writer": [{ output: draft(invalidSpec()) }, { output: draft(spec()) }],
		});

		const outcome = await runTriage(ctx, input, deps);

		expect(outcome).toMatchObject({ outcome: "drafted" });
		expect(calls.map((c) => c.agent)).toEqual(["triage", "spec-writer", "spec-writer"]);
		expect(calls[2]?.message).toContain("## Your previous submission was rejected");
		expect(calls[2]?.message).toContain("- Duplicate acceptance criterion IDs: AC-1");
		expect(parseMarker(written(gh)[0]?.body ?? "", "spec")?.spec).toEqual(spec());
	});

	it("fails the task when the spec is still invalid, posting no spec and closing the sandbox", async () => {
		const { gh, sandbox, calls, deps } = setup({
			triage: [{ output: decision({}) }],
			"spec-writer": [{ output: draft(invalidSpec()) }, { output: draft(invalidSpec()) }],
		});

		const outcome = await runTriage(ctx, input, deps);

		expect(outcome).toMatchObject({ state: "failed", outcome: "spec_invalid" });
		expect(outcome.summary).toContain("the spec failed validation twice: Duplicate acceptance criterion IDs: AC-1");
		expect(calls.filter((c) => c.agent === "spec-writer")).toHaveLength(2);
		expect(written(gh)).toEqual([]);
		expect(gh.status()).toContain("**Triage** failed: the spec failed validation twice");
		expect(sandbox.closed).toBe(1);
	});

	it.each<{ stage: string; revising: boolean; steps: Record<string, AgentStep[]> }>([
		{ stage: "triage", revising: false, steps: { triage: [thenLoseThread(decision({ decision: "ask", questions: ["Which pages?"] }))] } },
		{
			stage: "spec-writer",
			revising: true,
			steps: { triage: [{ output: decision({}) }], "spec-writer": [thenLoseThread(draft(spec({ goals: ["Changed"] })))] },
		},
	])("writes nothing once a newer run starts on the issue after $stage returns", async ({ revising, steps }) => {
		const { gh, deps } = setup(steps);
		const original = revising ? [specComment(gh, spec(), 1).body] : [];

		expect(await runTriage(ctx, input, deps)).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(written(gh).map((c) => c.body)).toEqual(original);
	});

	it("keeps the issue waiting when the reply that started it no longer exists", async () => {
		const { calls, deps } = setup({});

		expect(await runTriage(ctx, { ...input, commentId: 555 }, deps)).toMatchObject({ state: "done", outcome: "skipped" });
		expect(calls).toEqual([]);
		expect(await runRow(db, "trn-triage")).toMatchObject({ outcome: "skipped", waiting: "reply" });
	});

	it("removes the triage label once a labeled run starts, but not for a reply or a rejected actor", async () => {
		const ask = () => ({ triage: [{ output: decision({ decision: "ask", questions: ["Which pages?"] }) }] });
		const labeled = setup(ask());
		await runTriage(ctx, input, labeled.deps);
		expect(labeled.gh.labels(12).has(config.labels.triage)).toBe(false);

		const reply = setup(ask());
		reply.gh.comment(12, "maintainer", "All of them.");
		await runTriage({ metadata: { taskRunId: "trn-reply" } }, { ...input, commentId: reply.gh.comments.at(-1)?.id }, reply.deps);
		expect(reply.gh.labels(12).has(config.labels.triage)).toBe(true);

		const rejected = setup({});
		await runTriage({ metadata: { taskRunId: "trn-bob" } }, { ...input, actor: "bob" }, rejected.deps);
		expect(rejected.gh.labels(12).has(config.labels.triage)).toBe(true);
	});
});
