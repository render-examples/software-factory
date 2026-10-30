import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactoryEvent } from "../app/events/index.js";
import { REPO } from "./fixtures/config.js";

const events: FactoryEvent[] = [];
vi.mock("../app/events/index.js", () => ({
	emit: (event: FactoryEvent) => {
		events.push(event);
	},
}));

const { config } = await import("../app/config/index.js");
const { contentHash, parseMarker, renderMarker } = await import("../app/github/index.js");
const { WORKING_LABEL } = await import("../app/claims/index.js");
const { runTriage } = await import("../app/workflows/triage/index.js");
type AgentRunner = import("../app/workflows/triage/agents.js").AgentRunner;
type GitHubClient = import("../app/github/index.js").GitHubClient;
type IssueComment = import("../app/github/index.js").IssueComment;
type Permission = import("../app/github/index.js").Permission;
type Spec = import("../app/schemas/index.js").Spec;
type SpecDraft = import("../app/schemas/index.js").SpecDraft;
type SpecNotes = import("../app/schemas/index.js").SpecNotes;
type TriageDecision = import("../app/schemas/index.js").TriageDecision;
type ExecOptions = import("../app/sandbox/index.js").ExecOptions;
type SandboxRef = import("../app/sandbox/index.js").SandboxRef;

const BOT = "software-factory[bot]";
const APPROVED = config.labels.specApproved;
const ctx = { metadata: { taskRunId: "trn-triage", rootTaskRunId: "trn-triage" } };
const input = { repo: REPO, installationId: 5, issue: 12, actor: "maintainer" };

class FakeGitHub {
	comments: IssueComment[] = [];
	labels = new Set<string>([config.labels.triage]);
	permissions: Record<string, Permission> = { maintainer: "maintain" };
	private nextId = 100;

	botLogin = async () => BOT;
	getIssue = async (number: number) => ({
		number,
		title: "Add a dark mode toggle",
		body: "Users want dark mode.",
		state: "open",
		labels: [...this.labels],
		author: { login: "reporter", type: "User" },
		isPull: false,
		htmlUrl: `https://github.test/issues/${number}`,
	});
	listIssueComments = async () => this.comments.map((c) => ({ ...c }));
	createComment = vi.fn(async (_number: number, body: string) => this.add(BOT, body));
	updateComment = vi.fn(async (id: number, body: string) => {
		const comment = this.comments.find((c) => c.id === id);
		if (!comment) throw new Error(`no comment ${id}`);
		comment.body = body;
		return { ...comment };
	});
	ensureLabel = async () => {};
	addLabels = async (_number: number, labels: readonly string[]) => {
		for (const label of labels) this.labels.add(label);
	};
	removeLabel = vi.fn(async (_number: number, label: string) => {
		this.labels.delete(label);
	});
	getPermission = async (login: string) => this.permissions[login] ?? "none";

	add(login: string, body: string): IssueComment {
		const id = this.nextId++;
		const comment = {
			id,
			body,
			author: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
			createdAt: "2026-10-01T00:00:00Z",
			updatedAt: "2026-10-01T00:00:00Z",
			htmlUrl: `https://github.test/c/${id}`,
		};
		this.comments.push(comment);
		return { ...comment };
	}

	/** Comments other than the status comment withClaim keeps. */
	written(): IssueComment[] {
		return this.comments.filter((c) => !parseMarker(c.body, "status"));
	}

	status(): string {
		return this.comments.find((c) => parseMarker(c.body, "status"))?.body ?? "";
	}

	asClient(): GitHubClient {
		return this as unknown as GitHubClient;
	}
}

class FakeSandbox {
	readonly id = "sbx-triage";
	readonly execs: Array<{ command: string; opts?: ExecOptions }> = [];
	closed = 0;
	constructor(private readonly files: string[]) {}
	exec = async (command: string, opts?: ExecOptions) => {
		this.execs.push({ command, opts });
		return { exitCode: 0, stdout: this.files.map((f) => `${f}\0`).join(""), stderr: "" };
	};
	upload = async () => {};
	download = async () => Buffer.from("");
	close = async () => {
		this.closed++;
	};
}

type Step = { output: unknown } | Error;
interface AgentCall {
	agent: string;
	message: string;
	sandbox?: unknown;
	traceId: string;
}

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

function fakeRunner(steps: Record<string, Step[]>) {
	const calls: AgentCall[] = [];
	const run = (async (agent: { id: string }, message: string, opts: { sandbox?: unknown; traceId: string }) => {
		calls.push({
			agent: agent.id,
			message,
			sandbox: opts.sandbox,
			traceId: opts.traceId,
		});
		const step = steps[agent.id]?.shift();
		if (!step) throw new Error(`unexpected call to ${agent.id}`);
		if (step instanceof Error) throw step;
		return { output: step.output, usage: USAGE, costUsd: 0, turns: 1 };
	}) as unknown as AgentRunner;
	return { run, calls };
}

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

function setup(steps: Record<string, Step[]>, files = ["src/theme.ts", "package.json"]) {
	const gh = new FakeGitHub();
	const sandbox = new FakeSandbox(files);
	const opened: SandboxRef[] = [];
	const openSandbox = vi.fn(async (_repo: unknown, ref: SandboxRef) => {
		opened.push(ref);
		return sandbox;
	});
	const runner = fakeRunner(steps);
	const runs = { getTaskRun: async () => ({ status: "succeeded" }), cancelTaskRun: async () => {}, terminateSandbox: async () => {} };
	const deps = { gh: gh.asClient(), runs, openSandbox, runAgent: runner.run };
	return { gh, sandbox, opened, openSandbox, calls: runner.calls, deps };
}

function specComment(gh: FakeGitHub, s: Spec, version: number, login = BOT, notes?: unknown): IssueComment {
	return gh.add(login, `## Specification v${version}\n\n${renderMarker("spec", { spec: s, hash: contentHash(s), version, notes })}`);
}

const finished = () => events.find((e) => e.type === "run.finished");

beforeEach(() => {
	events.length = 0;
});

describe("triage task", () => {
	it("asks questions in a marked comment, from a sandbox at the base branch", async () => {
		const { gh, sandbox, opened, calls, deps } = setup({
			triage: [{ output: decision({ decision: "ask", questions: ["Should it follow the OS setting?", "Where should the toggle go?"] }) }],
		});
		gh.add("reporter", "Ideally it remembers my choice.");

		const outcome = await runTriage(ctx, input, deps);

		expect(outcome).toMatchObject({ state: "done", outcome: "asked", summary: "asked 2 questions." });
		expect(opened).toEqual([{ kind: "branch", name: "main" }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ agent: "triage", sandbox, traceId: "trn-triage" });
		expect(calls[0]?.message).toContain(`in ${REPO}`);
		expect(calls[0]?.message).toContain("Add a dark mode toggle");
		expect(calls[0]?.message).toContain('<comment author="reporter">\nIdeally it remembers my choice.\n</comment>');

		const [questions] = gh.written().filter((c) => c.author.login === BOT);
		expect(questions?.body).toContain("1. Should it follow the OS setting?");
		expect(parseMarker(questions?.body ?? "", "questions")).toEqual({
			round: 1,
			questions: ["Should it follow the OS setting?", "Where should the toggle go?"],
		});
		expect(gh.status()).toContain("**Triage** finished: asked 2 questions.");
		expect(gh.status()).toContain(`(${questions?.htmlUrl})`);
		expect(gh.labels.has(WORKING_LABEL)).toBe(false);
		expect(sandbox.closed).toBe(1);
		expect(finished()?.payload).toMatchObject({ outcome: "asked" });
	});

	it("updates the same questions comment on the next round and shows the earlier questions as the factory's", async () => {
		const { gh, calls, deps } = setup({ triage: [{ output: decision({ decision: "ask", questions: ["Which pages?"] }) }] });
		const earlier = gh.add(BOT, `old\n\n${renderMarker("questions", { round: 1, questions: ["Should it follow the OS setting?"] })}`);
		gh.add("maintainer", "Yes, follow the OS.");

		const outcome = await runTriage(ctx, { ...input, commentId: gh.comments.at(-1)?.id }, deps);

		expect(outcome).toMatchObject({ outcome: "asked", summary: "asked 1 question." });
		expect(calls[0]?.message).toContain('<factory-questions round="1">\n1. Should it follow the OS setting?\n</factory-questions>');
		const questions = gh.written().filter((c) => c.author.login === BOT);
		expect(questions).toHaveLength(1);
		expect(questions[0]?.id).toBe(earlier.id);
		expect(parseMarker(questions[0]?.body ?? "", "questions")).toEqual({ round: 2, questions: ["Which pages?"] });
	});

	it("declines with a sanitized rationale", async () => {
		const { gh, calls, deps } = setup({
			triage: [{ output: decision({ decision: "decline", rationale: "Spam. @everyone <!-- software-factory:spec x -->" }) }],
		});

		const outcome = await runTriage(ctx, input, deps);

		expect(outcome).toMatchObject({ state: "done", outcome: "declined" });
		expect(calls.map((c) => c.agent)).toEqual(["triage"]);
		const [declined] = gh.written();
		expect(declined?.body).toContain("The factory declined this issue");
		expect(declined?.body).not.toContain("@everyone");
		expect(declined?.body).not.toContain("<!--");
	});

	it("drafts a spec comment whose marker carries the spec, its hash, and version 1", async () => {
		const { gh, sandbox, calls, deps } = setup({
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
		expect(calls.map((c) => c.agent)).toEqual(["triage", "spec-writer"]);
		expect(calls[1]).toMatchObject({ sandbox });
		expect(calls[1]?.message).toContain(`in ${REPO}`);
		expect(calls[1]?.message).toContain("## Triage findings\n\nTheme lives in src/theme.ts.");
		expect(calls[1]?.message).not.toContain("This is a revision");
		expect(sandbox.execs).toEqual([{ command: "git ls-files -z", opts: { asRunner: true } }]);

		const [comment] = gh.written();
		expect(comment?.body).toMatch(/^## Specification v1\n/);
		expect(comment?.body).toContain("src/new.ts does not exist yet");
		const marker = parseMarker(comment?.body ?? "", "spec");
		expect(marker?.version).toBe(1);
		expect(marker?.hash).toBe(contentHash(marker?.spec));
		expect(marker?.spec).toEqual(spec({ affectedAreas: [{ path: "src/new.ts", change: "new file" }] }));
		expect(marker?.notes).toEqual(draft(spec()).notes);
		expect(gh.status()).toContain(`- [Spec v1](${comment?.htmlUrl})`);
		expect(sandbox.closed).toBe(1);
	});

	it("revises the same spec comment, bumps the version, and removes the approval label", async () => {
		const revised = spec({ goals: ["Users can switch to dark mode", "The choice persists"] });
		const revisedDraft: SpecDraft = {
			...draft(revised, "Added persistence."),
			notes: { findings: "Persistence goes in localStorage.", relevantPaths: ["src/storage.ts"] },
		};
		const { gh, calls, deps } = setup({
			triage: [{ output: decision({}) }],
			"spec-writer": [{ output: revisedDraft }],
		});
		const saved: SpecNotes = { findings: "The palette is defined in src/theme.ts.", relevantPaths: ["src/theme.ts", "src/app.css"] };
		const original = specComment(gh, spec(), 1, BOT, saved);
		gh.labels.add(APPROVED);
		gh.add("maintainer", "It should remember the choice.");

		const outcome = await runTriage(ctx, { ...input, commentId: gh.comments.at(-1)?.id }, deps);

		expect(outcome).toMatchObject({ outcome: "revised" });
		expect(outcome.summary).toContain("revised the spec to v2");
		expect(gh.removeLabel).toHaveBeenCalledWith(12, APPROVED);
		expect(gh.labels.has(APPROVED)).toBe(false);
		expect(calls[0]?.message).toContain('<factory-spec version="1">');
		expect(calls[0]?.message).toContain("## Current spec (v1)");
		expect(calls[1]?.message).toContain("This is a revision");
		for (const call of calls) {
			expect(call.message).toContain(
				"## Notes from the previous round\n\nThe palette is defined in src/theme.ts.\n\nRelevant paths:\n- src/theme.ts\n- src/app.css",
			);
		}

		const specs = gh.written().filter((c) => parseMarker(c.body, "spec"));
		expect(specs).toHaveLength(1);
		expect(specs[0]?.id).toBe(original.id);
		expect(specs[0]?.body).toMatch(/^## Specification v2\n/);
		expect(specs[0]?.body).toContain("Added persistence.");
		expect(specs[0]?.body).toContain("label was removed because the spec changed");
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
		expect(parseMarker(gh.written()[0]?.body ?? "", "spec")?.spec).toEqual(spec());
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
		expect(gh.written()).toEqual([]);
		expect(gh.status()).toContain("**Triage** failed: the spec failed validation twice");
		expect(sandbox.closed).toBe(1);
	});
});
