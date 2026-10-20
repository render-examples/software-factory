import { describe, expect, it } from "vitest";
import { AgentError, type BaseRunOptions, type RunAgentInput, type Usage, type runAgent } from "../app/agents/index.js";
import { config, requireRepo } from "../app/config/index.js";
import type { Spec, SpecDraft, TriageDecision } from "../app/schemas/index.js";
import type { FactoryEvent } from "../app/events/index.js";
import type { ExecResult, OpenedSandbox, SandboxRef } from "../app/sandbox/index.js";
import { EvalCase, type EvalFixture } from "../scripts/eval/case.js";
import { main } from "../scripts/eval/cli.js";
import { type EvalDeps, runEvals } from "../scripts/eval/suite.js";

const REPO_NAME = Object.keys(config.repos)[0] as string;
const repo = requireRepo(REPO_NAME, 7);
const TRACE = "eval-test-trace";
const FIXTURE: EvalFixture = {
	repo: repo.fullName,
	baseBranch: repo.config.baseBranch,
	sha: "a".repeat(40),
};
const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };

const decision = (over: Partial<TriageDecision> = {}): TriageDecision => ({
	decision: "draft",
	questions: [],
	rationale: "Clear.",
	findings: "server.js serves /api/todos.",
	relevantPaths: ["server.js"],
	...over,
});

const spec = (over: Partial<Spec> = {}): Spec => ({
	title: "Store todos in a Map",
	summary: "Keep todos in a Map keyed by id.",
	problem: "",
	goals: ["Constant-time lookups"],
	nonGoals: [],
	acceptanceCriteria: [{ id: "AC-1", text: "Lookups by id use the Map.", verification: "automated" }],
	approach: "",
	affectedAreas: [{ path: "server.js", change: "Use a Map." }],
	testPlan: "",
	risks: [],
	assumptions: [],
	openQuestions: [],
	...over,
});

const draft = (over: Partial<Spec> = {}): SpecDraft => ({ spec: spec(over), notes: { findings: "", relevantPaths: [] } });

const evalCase = (id: string, over: Partial<EvalCase> = {}): EvalCase =>
	EvalCase.parse({
		id,
		description: "A case.",
		stage: "triage",
		issue: { title: "Refactor todo storage", body: "Move todos into a Map keyed by ID." },
		expect: { decision: "draft", specMustMention: ["map"] },
		...over,
	});

class FakeSandbox implements OpenedSandbox {
	closed = 0;
	readonly execs: string[] = [];
	readonly manifest = {
		repo: repo.fullName,
		baseBranch: repo.config.baseBranch,
		sha: FIXTURE.sha,
		lockfileHash: "b".repeat(64),
		install: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		runnerHash: "c".repeat(64),
	};
	constructor(
		readonly id: string,
		readonly headSha = FIXTURE.sha,
	) {}
	async exec(command: string): Promise<ExecResult> {
		this.execs.push(command);
		return { exitCode: 0, stdout: command.startsWith("git ls-files") ? "server.js\0public/index.html\0" : "", stderr: "" };
	}
	async upload(): Promise<void> {}
	async download(): Promise<Buffer> {
		return Buffer.from("");
	}
	async close(): Promise<void> {
		this.closed++;
	}
}

interface Call {
	agentId: string;
	input: RunAgentInput;
	opts: BaseRunOptions & { sandbox?: OpenedSandbox };
}

/** Plays each agent's queued submissions (or errors) in order, at $0.50 a call. */
function fakeAgents(script: Record<string, Array<unknown>>) {
	const calls: Call[] = [];
	const run = (async (agent: { id: string }, input: RunAgentInput, opts: Call["opts"]) => {
		calls.push({ agentId: agent.id, input, opts });
		const next = script[agent.id]?.shift();
		if (next === undefined) throw new Error(`unexpected ${agent.id} call`);
		if (next instanceof Error) throw next;
		return { output: next, usage, costUsd: 0.5, turns: 1 };
	}) as unknown as typeof runAgent;
	return { run, calls };
}

function harness(script: Record<string, Array<unknown>>, opts: { openFails?: Set<number>; headSha?: string } = {}) {
	const sandboxes: FakeSandbox[] = [];
	const refs: SandboxRef[] = [];
	const events: FactoryEvent[] = [];
	const agents = fakeAgents(script);
	const deps: EvalDeps = {
		repo,
		openSandbox: async (_repo, ref) => {
			refs.push(ref);
			const n = refs.length;
			if (opts.openFails?.has(n)) throw new Error("no snapshot");
			const sandbox = new FakeSandbox(`sbx-${n}`, opts.headSha);
			sandboxes.push(sandbox);
			return sandbox;
		},
		runAgent: agents.run,
		emit: async (event) => {
			events.push(event);
		},
		budgetUsd: 3,
		fixture: FIXTURE,
		traceId: TRACE,
	};
	return { deps, sandboxes, refs, events, calls: agents.calls };
}

describe("runEvals", () => {
	it("opens one sandbox per case at the base branch, closes each, and grades the agents' work", async () => {
		const h = harness({ triage: [decision(), decision({ decision: "ask", questions: ["What should be searchable?"] })], "spec-writer": [draft()] });
		const cases = [evalCase("drafts"), evalCase("asks", { expect: { decision: "ask", questionsMax: 1 } })];

		const run = await runEvals(cases, h.deps);

		expect(h.refs).toEqual([
			{ kind: "branch", name: repo.config.baseBranch },
			{ kind: "branch", name: repo.config.baseBranch },
		]);
		expect(h.sandboxes.map((s) => s.closed)).toEqual([1, 1]);
		expect(h.calls.map((c) => [c.agentId, c.opts.sandbox?.id])).toEqual([
			["triage", "sbx-1"],
			["spec-writer", "sbx-1"],
			["triage", "sbx-2"],
		]);
		expect(run.results.map((r) => [r.id, r.pass, r.decision, r.costUsd])).toEqual([
			["drafts", true, "draft", 1],
			["asks", true, "ask", 0.5],
		]);
		expect([run.passed, run.failed, run.costUsd]).toEqual([2, 0, 1.5]);
	});

	it("closes the sandbox when an agent fails, counts the failed call's cost, and goes on to the next case", async () => {
		const h = harness({
			triage: [new AgentError("max_turns", "too many turns", usage, 0.25, 40), decision()],
			"spec-writer": [draft()],
		});

		const run = await runEvals([evalCase("fails"), evalCase("passes")], h.deps);

		expect(h.sandboxes.map((s) => s.closed)).toEqual([1, 1]);
		expect(run.results[0]).toMatchObject({ id: "fails", pass: false, costUsd: 0.25, error: "the triage agent ran out of turns." });
		expect(run.results[0]?.reasons[0]).toBe("stopped early: the triage agent ran out of turns.");
		expect(run.results[1]?.pass).toBe(true);
	});

	it("runs independent trials and requires every trial to pass", async () => {
		const h = harness({
			triage: [
				decision({ decision: "ask", questions: ["What should be searchable?"] }),
				decision({ decision: "ask", questions: ["What should be searchable?", "Which fields?"] }),
			],
		});
		const run = await runEvals([evalCase("asks", { expect: { decision: "ask", questionsMax: 1 } })], {
			...h.deps,
			trials: 2,
		});

		expect(run.results[0]).toMatchObject({ pass: false, passedTrials: 1, passRate: 0.5 });
		expect(run.results[0]?.reasons[0]).toContain("trial 2");
		expect(h.sandboxes.map((sandbox) => sandbox.closed)).toEqual([1, 1]);
	});

	it("rejects fixture drift before making a model call", async () => {
		const h = harness({}, { headSha: "d".repeat(40) });
		const run = await runEvals([evalCase("drift")], h.deps);

		expect(run.results[0]).toMatchObject({ pass: false, costUsd: 0 });
		expect(run.results[0]?.reasons[0]).toContain("fixture drift");
		expect(h.calls).toEqual([]);
	});
});

describe("main", () => {
	const quiet = () => {
		const lines: string[] = [];
		return { lines, out: (line: string) => lines.push(line) };
	};
	const env = { FACTORY_EVAL_INSTALLATION_ID: "7" };

	it("--validate checks the case files and touches no live service", async () => {
		const h = harness({});
		const o = quiet();
		expect(await main(["--validate"], { ...h.deps, out: o.out, env })).toBe(0);
		expect(h.refs).toEqual([]);
		expect(o.lines.join("\n")).toContain("14 case(s) valid.");
	});

	it("--validate filters cases by stage without requiring live credentials", async () => {
		const h = harness({});
		const o = quiet();
		expect(await main(["--validate", "--stage", "pr-review"], { ...h.deps, out: o.out, env: {} })).toBe(0);
		expect(o.lines.join("\n")).toContain("3 case(s) valid.");
		expect(o.lines.join("\n")).not.toContain("underspecified-search");
	});
});
