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
const { config } = await import("../app/config/index.js");
const { contentHash, parseMarker, renderMarker } = await import("../app/github/index.js");
const { runSpecToPr } = await import("../app/workflows/spec-to-pr/index.js");
const { VERIFY_TIMEOUT_MS } = await import("../app/workflows/spec-to-pr/verify.js");
type Spec = import("../app/contracts/index.js").Spec;
type Implementation = import("../app/contracts/index.js").Implementation;
type ImplementationReview = import("../app/contracts/index.js").ImplementationReview;
type IssueComment = import("../app/github/index.js").IssueComment;
type GitHubClient = import("../app/github/index.js").GitHubClient;
type GitDataClient = import("../app/github/index.js").GitDataClient;
type GitCommit = import("../app/github/index.js").GitCommit;
type ExecOptions = import("../app/sandbox/index.js").ExecOptions;
type ExecResult = import("../app/sandbox/index.js").ExecResult;
type SpecToPrDeps = import("../app/workflows/spec-to-pr/index.js").SpecToPrDeps;
type PublishResult = import("../app/publish/index.js").PublishResult;

const BOT = "software-factory[bot]";
const BOT_ID = 4242;
const REPO = "render-examples/render-factory-example-target";
const BASE = "b".repeat(40);
const ISSUE = 12;
const BRANCH = `factory/issue-${ISSUE}`;
const ctx = { metadata: { taskRunId: "trn-spec" } };
const NOW = new Date("2026-10-18T23:37:05.123Z");
const LABELED_AT = "2026-10-18T20:00:00Z";
const input = { repo: REPO, installationId: 5, issue: ISSUE, actor: "alice", labeledAt: LABELED_AT };

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
const CLEAN: ImplementationReview = { needsRevision: false, issues: [], notes: [] };

function fakeGitHub(opts: { spec?: unknown; specUpdatedAt?: string; labelEvents?: string[] } = {}) {
	const comments: IssueComment[] = [];
	let nextId = 1;
	const add = (login: string, body: string, updatedAt = "2026-10-18T19:00:00Z"): IssueComment => {
		const comment = {
			id: nextId++,
			body,
			author: { login, type: "Bot" },
			performedViaApp: null,
			createdAt: updatedAt,
			updatedAt,
			htmlUrl: `https://github.com/${REPO}/issues/${ISSUE}#c${nextId}`,
		};
		comments.push(comment);
		return comment;
	};
	if (opts.spec !== null) {
		const spec = opts.spec ?? SPEC;
		add(BOT, `## Spec\n\n${renderMarker("spec", { spec, hash: contentHash(spec), version: 1 })}`, opts.specUpdatedAt);
	}
	const gh = {
		botLogin: async () => BOT,
		listIssueComments: async () => comments.map((c) => ({ ...c })),
		createComment: async (_n: number, body: string) => add(BOT, body),
		updateComment: async (id: number, body: string) => {
			const comment = comments.find((c) => c.id === id) as IssueComment;
			comment.body = body;
			return comment;
		},
		ensureLabel: async () => {},
		addLabels: async () => {},
		removeLabel: async () => {},
		getPermission: async () => "write" as const,
		getIssue: async (number: number) => ({
			number,
			title: "Health checks",
			body: "",
			state: "open",
			labels: [],
			author: { login: "alice", type: "User" },
			isPull: false,
			htmlUrl: "",
		}),
		getLabelEvents: vi.fn(async (_n: number, label: string) => (opts.labelEvents ?? []).map((createdAt) => ({ label, createdAt, actor: null }))),
		http: { json: vi.fn(async (_method: string, path: string) => (path === `/users/${encodeURIComponent(BOT)}` ? { id: BOT_ID } : undefined)) },
		findOrCreatePull: vi.fn(async (_args: { head: string; base: string; title: string; body: string; draft?: boolean }) => ({
			pull: { number: 34, htmlUrl: `https://github.com/${REPO}/pull/34` },
			created: true,
		})),
	};
	const status = () => {
		const comment = comments.find((c) => parseMarker(c.body, "status"));
		return { body: comment?.body ?? "", data: comment ? parseMarker(comment.body, "status") : null };
	};
	return { gh, comments, status };
}

/** Verify commands answer from per-command queues; the last answer repeats. */
function fakeSandbox(opts: { changed?: boolean; verify?: Record<string, ExecResult[]> } = {}) {
	const execs: Array<{ command: string; opts?: ExecOptions }> = [];
	const queues = new Map(Object.entries(opts.verify ?? {}).map(([k, v]) => [k, [...v]]));
	const sandbox = {
		id: "sbx-1",
		headSha: BASE,
		manifest: { repo: REPO, baseBranch: "main", sha: BASE, lockfileHash: "", install: null, createdAt: "" },
		exec: vi.fn(async (command: string, execOpts?: ExecOptions): Promise<ExecResult> => {
			execs.push({ command, opts: execOpts });
			if (command.startsWith("git status")) return { exitCode: 0, stdout: opts.changed === false ? "" : " M src/server.ts\n", stderr: "" };
			const queue = queues.get(command);
			const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
			return next ?? { exitCode: 0, stdout: "ok", stderr: "" };
		}),
		upload: async () => {},
		download: async () => Buffer.alloc(0),
		close: vi.fn(async () => {}),
	};
	return { sandbox, execs };
}

const fail = (stdout: string): ExecResult => ({ exitCode: 1, stdout, stderr: "" });

type AgentStep = { output: unknown; costUsd: number } | InstanceType<typeof AgentError>;

/** Answers each agent from its own queue, by agent id. */
function fakeAgents(steps: { implementer?: AgentStep[]; "implementation-reviewer"?: AgentStep[] }) {
	const calls: Array<{ agent: string; message: string; vars?: Record<string, string>; opts: Record<string, unknown> }> = [];
	const queues: Record<string, AgentStep[]> = {
		implementer: steps.implementer ?? [{ output: implementation(), costUsd: 3 }],
		"implementation-reviewer": steps["implementation-reviewer"] ?? [{ output: CLEAN, costUsd: 1 }],
	};
	const runAgent = vi.fn(
		async (agent: { id: string }, agentInput: { message: string; vars?: Record<string, string> }, opts: Record<string, unknown>) => {
			calls.push({ agent: agent.id, message: agentInput.message, vars: agentInput.vars, opts });
			const step = queues[agent.id]?.shift();
			if (!step) throw new Error(`unexpected ${agent.id} call`);
			if (step instanceof AgentError) throw step;
			return { output: step.output, costUsd: step.costUsd, usage: {}, turns: 1 };
		},
	);
	return { runAgent: runAgent as unknown as SpecToPrDeps["runAgent"], calls };
}

function fakeGitData(branch: { tip: string | null; commit?: Partial<GitCommit> }) {
	const git = {
		getRef: vi.fn(async () => branch.tip),
		getCommit: vi.fn(async (sha: string) => ({ sha, treeSha: "c".repeat(40), parents: [BASE], ...branch.commit })),
	};
	return git as unknown as GitDataClient & typeof git;
}

const PUBLISHED: PublishResult = { commitSha: "d".repeat(40), treeSha: "e".repeat(40), changedFiles: [] };

function setup(
	opts: {
		gh?: Parameters<typeof fakeGitHub>[0];
		sandbox?: Parameters<typeof fakeSandbox>[0];
		agents?: Parameters<typeof fakeAgents>[0];
		branch?: Parameters<typeof fakeGitData>[0];
		publish?: PublishResult | Error;
	} = {},
) {
	const github = fakeGitHub(opts.gh);
	const box = fakeSandbox(opts.sandbox);
	const agents = fakeAgents(opts.agents ?? {});
	const git = fakeGitData(opts.branch ?? { tip: null });
	const openSandbox = vi.fn(async () => box.sandbox);
	const publish = vi.fn(async () => {
		if (opts.publish instanceof Error) throw opts.publish;
		return opts.publish ?? PUBLISHED;
	});
	const deps: SpecToPrDeps = {
		gh: github.gh as unknown as GitHubClient,
		runs: { getTaskRun: async () => ({ status: "succeeded" }), cancelTaskRun: async () => {} },
		gitData: git,
		openSandbox,
		runAgent: agents.runAgent,
		publish: publish as unknown as SpecToPrDeps["publish"],
		now: () => NOW,
	};
	const run = () => runSpecToPr(ctx, input, deps);
	return { ...github, ...box, ...agents, git, openSandbox, publish, run };
}

const verifyCommands = (execs: Array<{ command: string }>) => execs.filter((e) => !e.command.startsWith("git status")).map((e) => e.command);
const finished = () => events.find((e) => e.type === "run.finished")?.payload as Record<string, unknown>;

beforeEach(() => {
	events.length = 0;
});

describe("approval", () => {
	it("refuses when there is no spec comment, before opening a sandbox", async () => {
		const t = setup({ gh: { spec: null } });
		const outcome = await t.run();
		expect(outcome).toMatchObject({ state: "failed", outcome: "no_spec" });
		expect(t.status().body).toContain(config.labels.triage);
		expect(t.openSandbox).not.toHaveBeenCalled();
	});

	it("refuses a spec edited after the newest approval label event", async () => {
		const t = setup({ gh: { labelEvents: ["2026-10-18T10:00:00Z", "2026-10-18T19:30:00Z"], specUpdatedAt: "2026-10-18T19:45:00Z" } });
		const outcome = await t.run();
		expect(outcome).toMatchObject({ state: "failed", outcome: "spec_changed" });
		expect(t.status().body).toContain("the spec changed after it was approved");
		expect(t.openSandbox).not.toHaveBeenCalled();
	});
});

describe("implement, verify, and publish", () => {
	it("opens a draft PR on the happy path, passing the remaining budget down and summing costs", async () => {
		const t = setup();
		const outcome = await t.run();

		expect(outcome).toMatchObject({ state: "done", outcome: "pr_opened" });
		expect(t.openSandbox).toHaveBeenCalledWith(expect.objectContaining({ fullName: REPO }), { kind: "branch", name: "main" });
		expect(t.calls.map((c) => c.agent)).toEqual(["implementer", "implementation-reviewer"]);
		const [impl, review] = t.calls;
		expect(impl?.message).toContain(`issue #${ISSUE}: Health checks`);
		expect(impl?.message).toContain("GET /health returns 200");
		expect(impl?.vars).toEqual({ repo: REPO, verifyCommands: "- `npm run build`\n- `npm test`" });
		expect(impl?.opts).toMatchObject({ sandbox: t.sandbox, traceId: "trn-spec", budgetUsd: config.limits.perRunUsd });
		expect(review?.vars).toEqual({ repo: REPO, baseRef: BASE });
		expect(review?.message).toContain("Added GET /health.");
		expect(review?.opts).toMatchObject({ sandbox: t.sandbox, budgetUsd: config.limits.perRunUsd - 3 });
		expect(finished()).toMatchObject({ outcome: "pr_opened", costUsd: 4 });

		expect(t.execs.filter((e) => !e.command.startsWith("git status"))).toEqual([
			{ command: "npm run build", opts: { asRunner: true, timeoutMs: VERIFY_TIMEOUT_MS } },
			{ command: "npm test", opts: { asRunner: true, timeoutMs: VERIFY_TIMEOUT_MS } },
		]);
		expect(t.publish).toHaveBeenCalledWith(
			expect.objectContaining({ sandbox: t.sandbox, baseSha: BASE, branch: BRANCH, ownedCommits: [], gitData: t.git }),
		);
		const pr = t.gh.findOrCreatePull.mock.calls[0]?.[0];
		expect(pr).toMatchObject({ head: BRANCH, base: "main", title: SPEC.title, draft: true });
		expect(pr?.body).toContain("Added GET /health.");
		expect(pr?.body).toContain("✅ passed");
		expect(t.status().data?.state).toBe("done");
		expect(t.status().body).toContain(`[Draft PR #34](https://github.com/${REPO}/pull/34)`);
		expect(t.sandbox.close).toHaveBeenCalledOnce();
	});

	it("repairs a failing verify and publishes once it passes", async () => {
		const t = setup({
			sandbox: { verify: { "npm test": [fail("FAIL src/server.test.ts\nexpected 200, got 404"), { exitCode: 0, stdout: "", stderr: "" }] } },
			agents: {
				implementer: [
					{ output: implementation(), costUsd: 3 },
					{ output: implementation({ summary: "Fixed the route.", followUps: ["Add metrics"] }), costUsd: 2 },
				],
			},
		});
		expect(await t.run()).toMatchObject({ state: "done", outcome: "pr_opened" });

		const repair = t.calls[1];
		expect(repair?.agent).toBe("implementer");
		expect(repair?.message).toContain("expected 200, got 404");
		expect(repair?.message).toContain("repair round 1 of 2");
		expect(repair?.opts).toMatchObject({ budgetUsd: config.limits.perRunUsd - 3 });
		expect(verifyCommands(t.execs)).toEqual(["npm run build", "npm test", "npm run build", "npm test"]);
		const body = t.gh.findOrCreatePull.mock.calls[0]?.[0].body ?? "";
		expect(body).toContain("Added GET /health.");
		expect(body).toContain("Add metrics");
		expect(finished()).toMatchObject({ costUsd: 6 });
	});

	it("fails without publishing when repairs run out, naming the failing commands but not their output", async () => {
		const t = setup({
			sandbox: { verify: { "npm test": [fail("SECRET-LOOKING LOG LINE")] } },
			agents: {
				implementer: [
					{ output: implementation(), costUsd: 3 },
					{ output: implementation(), costUsd: 2 },
					{ output: implementation(), costUsd: 2 },
				],
			},
		});
		const outcome = await t.run();

		expect(outcome).toMatchObject({ state: "failed", outcome: "verification_failed" });
		expect(t.calls.filter((c) => c.agent === "implementer")).toHaveLength(1 + config.limits.repairRounds);
		expect(t.calls.some((c) => c.agent === "implementation-reviewer")).toBe(false);
		expect(t.publish).not.toHaveBeenCalled();
		expect(t.gh.findOrCreatePull).not.toHaveBeenCalled();
		expect(t.status().body).toContain("`npm test` (exit 1)");
		expect(t.status().body).not.toContain("SECRET-LOOKING");
		expect(finished()).toMatchObject({ state: "failed", costUsd: 7 });
		expect(t.sandbox.close).toHaveBeenCalledOnce();
	});

	it("runs one revision pass when implementation review asks for it, then verifies again", async () => {
		const flagged: ImplementationReview = {
			needsRevision: true,
			issues: [{ file: "src/server.ts", line: 3, problem: "Remove the console.log." }],
			notes: [],
		};
		const t = setup({
			agents: {
				implementer: [
					{ output: implementation(), costUsd: 3 },
					{ output: implementation({ summary: "Removed the log." }), costUsd: 1 },
				],
				"implementation-reviewer": [{ output: flagged, costUsd: 1 }],
			},
		});
		expect(await t.run()).toMatchObject({ state: "done", outcome: "pr_opened" });

		expect(t.calls.map((c) => c.agent)).toEqual(["implementer", "implementation-reviewer", "implementer"]);
		expect(t.calls[2]?.message).toContain("src/server.ts:3: Remove the console.log.");
		expect(t.calls[2]?.opts).toMatchObject({ budgetUsd: config.limits.perRunUsd - 4 });
		expect(verifyCommands(t.execs)).toEqual(["npm run build", "npm test", "npm run build", "npm test"]);
		const body = t.gh.findOrCreatePull.mock.calls[0]?.[0].body ?? "";
		expect(body).toContain("revised the change");
		expect(finished()).toMatchObject({ costUsd: 5 });
	});
});

describe("rerunning on an existing branch", () => {
	it("leaves a branch with a person's commit alone, before spending anything", async () => {
		const t = setup({ branch: { tip: "f".repeat(40), commit: { committer: { name: "Alice", email: "alice@example.com" } } } });
		expect(await t.run()).toMatchObject({ state: "failed", outcome: "branch_taken" });
		expect(t.calls).toHaveLength(0);
		expect(t.publish).not.toHaveBeenCalled();
		expect(t.status().body).toContain(`\`${BRANCH}\` has commits the factory didn't make`);
		expect(t.sandbox.close).toHaveBeenCalledOnce();
	});
});
