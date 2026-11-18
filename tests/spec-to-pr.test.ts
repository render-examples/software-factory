import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../app/db/index.js";
import { BUILD_COMMAND, REPO, TEST_COMMAND } from "./fixtures/config.js";
import { pgliteDb, resetDb } from "./helpers/db.js";
import { type AgentStep, fakeAgents } from "./helpers/fake-agents.js";
import { BOT, FakeGitHub } from "./helpers/fake-github.js";
import { FakeOpenedSandbox, ok } from "./helpers/fake-sandbox.js";
import { FakeRuns, runRow, startRun } from "./helpers/runs.js";

const { config } = await import("../app/config/index.js");
const { contentHash, renderMarker } = await import("../app/github/index.js");
const { runSpecToPr } = await import("../app/workflows/spec-to-pr/index.js");
type Spec = import("../app/schemas/index.js").Spec;
type Implementation = import("../app/schemas/index.js").Implementation;
type ExecResult = import("../app/sandbox/index.js").ExecResult;
type SpecToPrInput = import("../app/schemas/index.js").SpecToPrInput;
type SpecToPrDeps = import("../app/workflows/spec-to-pr/index.js").SpecToPrDeps;
type PublishInput = import("../app/changeset/index.js").PublishInput;

const BASE = "b".repeat(40);
const COMMIT = "d".repeat(40);
const ISSUE = 12;
const BRANCH = `factory/issue-${ISSUE}`;
const ctx = { metadata: { taskRunId: "trn-spec" } };
const NOW = new Date("2026-10-18T23:37:05.123Z");
const LABELED_AT = "2026-10-18T20:00:00Z";
const input = {
	repo: REPO,
	installationId: 5,
	issue: ISSUE,
	actor: "alice",
	approval: { kind: "label" as const, labeledAt: LABELED_AT },
};

const SPEC: Spec = {
	title: "Add a health endpoint",
	summary: "Expose GET /health.",
	problem: "Load balancers can't tell if the app is up.",
	goals: ["Return 200 when healthy"],
	nonGoals: [],
	acceptanceCriteria: [{ id: "AC-1", text: "GET /health returns 200", verification: "automated" }],
	approach: "Add a route.",
	affectedAreas: [{ path: "src/server.ts", change: "add the route" }],
	testPlan: "A request test.",
	risks: [],
	assumptions: [],
	openQuestions: [],
};

const implementation = (overrides: Partial<Implementation> = {}): Implementation => ({
	summary: "Added GET /health.",
	filesChanged: ["src/server.ts"],
	verification: [],
	followUps: [],
	...overrides,
});

const fail = (stdout: string): ExecResult => ({ exitCode: 1, stdout, stderr: "" });

function setup(
	opts: {
		spec?: Spec | null;
		specUpdatedAt?: string;
		labelEvents?: string[];
		verify?: Record<string, ExecResult[]>;
		implementer?: AgentStep[];
		afterPublish?: () => Promise<unknown>;
		input?: SpecToPrInput;
	} = {},
) {
	const gh = new FakeGitHub();
	gh.labels(ISSUE).add(config.labels.specApproved);
	if (opts.spec !== null) {
		const spec = opts.spec ?? SPEC;
		const marker = renderMarker("spec", { spec, hash: contentHash(spec), version: 1 });
		gh.comment(ISSUE, BOT, `## Spec\n\n${marker}`, opts.specUpdatedAt ?? "2026-10-18T19:00:00Z");
	}
	for (const createdAt of opts.labelEvents ?? []) gh.labelEvents.push({ issue: ISSUE, label: config.labels.specApproved, createdAt, actor: null });
	const sandbox = new FakeOpenedSandbox({ headSha: BASE, results: { "git status": ok(" M src/server.ts\n"), ...opts.verify } });
	const agents = fakeAgents({ implementer: opts.implementer ?? [{ output: implementation() }] });
	const publish = async (args: PublishInput) => {
		gh.commits.set(COMMIT, { sha: COMMIT, treeSha: "e".repeat(40), parents: [args.baseSha], committer: args.author });
		gh.refs.set(args.branch, COMMIT);
		await opts.afterPublish?.();
		return { commitSha: COMMIT, treeSha: "e".repeat(40), changedFiles: [] };
	};
	const deps: SpecToPrDeps = {
		gh: gh.asClient(),
		runs: new FakeRuns(),
		db,
		gitData: gh.gitData(),
		openSandbox: sandbox.open,
		runAgent: agents.run,
		publish,
		now: () => NOW,
	};
	const run = () => runSpecToPr(ctx, opts.input ?? input, deps);
	return { gh, sandbox, calls: agents.calls, run };
}

const verifyCommands = (execs: Array<{ command: string }>) => execs.filter((e) => !e.command.startsWith("git status")).map((e) => e.command);
const finished = () => runRow(db, "trn-spec");
const loseThread = () => startRun(db, REPO, { kind: "issue", number: ISSUE }, { traceId: "trn-newer" });

let db: Db;
beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
beforeEach(() => resetDb(db));

describe("approval", () => {
	it("refuses when there is no spec comment, before opening a sandbox", async () => {
		const t = setup({ spec: null });
		const outcome = await t.run();
		expect(outcome).toMatchObject({ state: "failed", outcome: "no_spec" });
		expect(t.gh.status()).toContain(config.labels.triage);
		expect(t.sandbox.opened).toEqual([]);
	});

	it("refuses a spec edited after the newest approval label event", async () => {
		const t = setup({ labelEvents: ["2026-10-18T10:00:00Z", "2026-10-18T19:30:00Z"], specUpdatedAt: "2026-10-18T19:45:00Z" });
		const outcome = await t.run();
		expect(outcome).toMatchObject({ state: "failed", outcome: "spec_changed" });
		expect(t.gh.status()).toContain("the spec changed after it was approved");
		expect(t.sandbox.opened).toEqual([]);
	});

	it("accepts the exact spec handed off by an autopilot Triage child, whatever the approval label's history", async () => {
		const t = setup({
			labelEvents: ["2026-10-18T10:00:00Z"],
			specUpdatedAt: "2026-10-18T19:45:00Z",
			input: {
				...input,
				approval: { kind: "autopilot", commentId: 100, hash: contentHash(SPEC), version: 1 },
			},
		});
		const outcome = await t.run();
		expect(outcome).toMatchObject({ state: "done", outcome: "pr_opened" });
	});

	it("refuses an autopilot handoff when the current spec does not match it", async () => {
		const t = setup({
			input: {
				...input,
				approval: { kind: "autopilot", commentId: 100, hash: "f".repeat(64), version: 1 },
			},
		});
		const outcome = await t.run();
		expect(outcome).toMatchObject({ state: "failed", outcome: "spec_changed" });
		expect(t.sandbox.opened).toEqual([]);
	});
});

describe("implement, verify, and publish", () => {
	it("opens a draft PR on the happy path and links its thread to the issue's", async () => {
		const t = setup();
		const outcome = await t.run();

		expect(outcome).toMatchObject({
			state: "done",
			outcome: "pr_opened",
			data: { kind: "pull_request", pr: 34, headSha: COMMIT },
		});
		expect(await finished()).toMatchObject({ state: "done", outcome: "pr_opened" });
		expect(t.sandbox.opened).toEqual([{ repo: REPO, kind: "branch", name: "main" }]);
		expect(t.sandbox.execs.every((e) => e.opts?.asRunner)).toBe(true);
		expect(t.gh.commits.get(t.gh.refs.get(BRANCH) ?? "")?.parents).toEqual([BASE]);
		expect(t.gh.pulls).toMatchObject([{ number: 34, headRef: BRANCH, baseRef: "main", title: SPEC.title, draft: true }]);
		expect(t.gh.pulls[0]?.body).toContain("Added GET /health.");
		expect(t.gh.status()).toContain(`[Draft PR #34](${t.gh.pulls[0]?.htmlUrl})`);
		expect(t.sandbox.closed).toBe(1);
		expect(t.gh.labels(ISSUE).has(config.labels.specApproved)).toBe(false);
	});

	it("repairs a failing verify and publishes once it passes", async () => {
		const t = setup({
			verify: { [TEST_COMMAND]: [fail("FAIL src/server.test.ts\nexpected 200, got 404"), ok()] },
			implementer: [{ output: implementation() }, { output: implementation({ summary: "Fixed the route.", followUps: ["Add metrics"] }) }],
		});
		expect(await t.run()).toMatchObject({ state: "done", outcome: "pr_opened" });

		const repair = t.calls[1];
		expect(repair?.agent).toBe("implementer");
		expect(repair?.message).toContain("expected 200, got 404");
		expect(verifyCommands(t.sandbox.execs)).toEqual([BUILD_COMMAND, TEST_COMMAND, BUILD_COMMAND, TEST_COMMAND]);
		const body = t.gh.pulls[0]?.body ?? "";
		expect(body).toContain("Added GET /health.");
		expect(body).toContain("Add metrics");
	});

	it("fails without publishing when repairs run out, naming the failing commands but not their output", async () => {
		const t = setup({
			verify: { [TEST_COMMAND]: [fail("SECRET-LOOKING LOG LINE")] },
			implementer: [{ output: implementation() }, { output: implementation() }, { output: implementation() }],
		});
		const outcome = await t.run();

		expect(outcome).toMatchObject({ state: "failed", outcome: "verification_failed" });
		expect(t.calls.filter((c) => c.agent === "implementer")).toHaveLength(1 + config.limits.repairRounds);
		expect(t.gh.refs.has(BRANCH)).toBe(false);
		expect(t.gh.pulls).toEqual([]);
		expect(t.gh.status()).toContain(`\`${TEST_COMMAND}\` (exit 1)`);
		expect(t.gh.status()).not.toContain("SECRET-LOOKING");
		expect(await finished()).toMatchObject({ state: "failed", outcome: "verification_failed" });
		expect(t.sandbox.closed).toBe(1);
	});
});

describe("rerunning on an existing branch", () => {
	it("leaves a branch with a person's commit alone, before spending anything", async () => {
		const t = setup();
		const tip = "f".repeat(40);
		t.gh.refs.set(BRANCH, tip);
		t.gh.commits.set(tip, { sha: tip, treeSha: "c".repeat(40), parents: [BASE], committer: { name: "Alice", email: "alice@example.com" } });
		expect(await t.run()).toMatchObject({ state: "failed", outcome: "branch_taken" });
		expect(t.calls).toHaveLength(0);
		expect(t.gh.refs.get(BRANCH)).toBe(tip);
		expect(t.gh.status()).toContain(`\`${BRANCH}\` has commits the factory didn't make`);
		expect(t.sandbox.closed).toBe(1);
	});
});

describe("losing the thread", () => {
	it.each([
		{
			during: "implementation",
			published: false,
			opts: {
				implementer: [
					async () => {
						await loseThread();
						return implementation();
					},
				],
			},
		},
		{ during: "publishing", published: true, opts: { afterPublish: loseThread } },
	])("opens no pull request once a newer run starts on the issue during $during", async ({ published, opts }) => {
		const t = setup(opts);
		expect(await t.run()).toMatchObject({ state: "cancelled", outcome: "superseded" });
		expect(t.gh.refs.has(BRANCH)).toBe(published);
		expect(t.gh.pulls).toEqual([]);
	});
});
