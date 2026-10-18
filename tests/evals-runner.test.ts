import { describe, expect, it } from "vitest";
import { AgentError, type BaseRunOptions, type RunAgentInput, type Usage } from "../app/agents/index.js";
import { config, requireRepo } from "../app/config/index.js";
import type { Spec, SpecDraft, TriageDecision } from "../app/contracts/index.js";
import type { FactoryEvent } from "../app/events/index.js";
import type { ExecResult, Sandbox, SandboxRef } from "../app/sandbox/index.js";
import type { AgentRunner } from "../app/workflows/triage/agents.js";
import { readThread, triageMessage } from "../app/workflows/triage/thread.js";
import { EvalCase } from "../scripts/eval/case.js";
import { main } from "../scripts/eval/cli.js";
import { caseComments, caseIssue, EVAL_BOT, type EvalDeps, runEvals } from "../scripts/eval/run.js";

const REPO_NAME = Object.keys(config.repos)[0] as string;
const repo = requireRepo(REPO_NAME, 7);
const TRACE = "eval-test-trace";
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
		phase: "triage",
		issue: { title: "Refactor todo storage", body: "Move todos into a Map keyed by ID." },
		expect: { decision: "draft", specMustMention: ["map"] },
		...over,
	});

class FakeSandbox implements Sandbox {
	closed = 0;
	readonly execs: string[] = [];
	constructor(readonly id: string) {}
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
	opts: BaseRunOptions & { sandbox?: Sandbox };
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
	}) as unknown as AgentRunner;
	return { run, calls };
}

function harness(script: Record<string, Array<unknown>>, opts: { openFails?: Set<number> } = {}) {
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
			const sandbox = new FakeSandbox(`sbx-${n}`);
			sandboxes.push(sandbox);
			return sandbox;
		},
		runAgent: agents.run,
		emit: async (event) => {
			events.push(event);
		},
		budgetUsd: 3,
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

	it("sends the agents the same messages the triage phase builds, with the run's trace and a shared budget", async () => {
		const h = harness({ triage: [decision()], "spec-writer": [draft()] });
		const c = evalCase("messages", {
			comments: [
				{ author: "maintainer", body: "Keep the API unchanged." },
				{ author: "renovate[bot]", body: "Dependency update notice.", bot: true },
			],
		});

		await runEvals([c], h.deps);

		const [triageCall, specCall] = h.calls;
		expect(triageCall?.input.message).toBe(triageMessage(repo.fullName, readThread(caseIssue(c), caseComments(c), EVAL_BOT)));
		expect(triageCall?.input.message).toContain("Keep the API unchanged.");
		expect(triageCall?.input.message).not.toContain("Dependency update notice.");
		expect(triageCall?.input.vars).toEqual({ repo: repo.fullName });
		expect(specCall?.input.message).toContain("## Triage findings");
		for (const call of h.calls) {
			expect(call.opts).toMatchObject({ traceId: TRACE, runId: `${TRACE}/messages`, repo: repo.fullName, subject: "eval:messages" });
		}
		expect(triageCall?.opts.budgetUsd).toBe(3);
		expect(specCall?.opts.budgetUsd).toBe(2.5);
	});

	it("emits eval.started, one eval.case per case, and eval.finished, all on one trace", async () => {
		const h = harness({ triage: [decision(), decision({ decision: "decline" })], "spec-writer": [draft()] });

		await runEvals([evalCase("one"), evalCase("two")], h.deps);

		expect(h.events.map((e) => e.type)).toEqual(["eval.started", "eval.case", "eval.case", "eval.finished"]);
		expect(new Set(h.events.map((e) => e.traceId))).toEqual(new Set([TRACE]));
		expect(h.events[0]?.payload).toMatchObject({ cases: ["one", "two"], budgetUsd: 3 });
		expect(h.events[1]).toMatchObject({ subject: "eval:one", payload: { caseId: "one", pass: true, decision: "draft", specTitle: "Store todos in a Map" } });
		expect(h.events[2]?.payload).toMatchObject({ caseId: "two", pass: false, decision: "decline" });
		expect(h.events[3]?.payload).toMatchObject({ passed: 1, failed: 1, costUsd: 1.5 });
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

	it("closes the sandbox when the platform throws, too", async () => {
		const h = harness({ triage: [new Error("sandbox exec failed")] });
		const run = await runEvals([evalCase("boom")], h.deps);
		expect(h.sandboxes[0]?.closed).toBe(1);
		expect(run.results[0]).toMatchObject({ pass: false, error: "sandbox exec failed" });
	});

	it("fails a case whose sandbox won't open, without calling an agent", async () => {
		const h = harness({ triage: [decision()], "spec-writer": [draft()] }, { openFails: new Set([1]) });
		const run = await runEvals([evalCase("no-sandbox"), evalCase("ok")], h.deps);
		expect(run.results[0]).toMatchObject({ pass: false, error: "could not open a sandbox: no snapshot" });
		expect(h.calls.map((c) => c.opts.sandbox?.id)).toEqual(["sbx-2", "sbx-2"]);
	});

	it("grades every submission, including a spec draft validation rejected", async () => {
		const rejected = draft({
			acceptanceCriteria: [
				{ id: "AC-1", text: "x", verification: "automated" },
				{ id: "AC-1", text: "APPROVAL-TOKEN-7F3A", verification: "manual" },
			],
		});
		const h = harness({ triage: [decision()], "spec-writer": [rejected, draft()] });
		const c = evalCase("retry", { expect: { decision: "draft", mustNotContain: ["approval-token-7f3a"] } });

		const run = await runEvals([c], h.deps);

		expect(h.calls.map((c) => c.agentId)).toEqual(["triage", "spec-writer", "spec-writer"]);
		expect(h.calls[2]?.input.message).toContain("## Your previous submission was rejected");
		expect(run.results[0]).toMatchObject({ pass: false, reasons: ['spec-writer output #2 contains "approval-token-7f3a"'] });
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
		expect(o.lines.join("\n")).toContain("7 case(s) valid.");
	});

	it("validates only when CI is set, unless --live", async () => {
		const h = harness({ triage: [decision({ decision: "ask", questions: ["What?"] })] });
		expect(await main([], { ...h.deps, out: quiet().out, env: { ...env, CI: "true" } })).toBe(0);
		expect(h.refs).toEqual([]);
		expect(await main(["--live", "--case", "underspecified-search"], { ...h.deps, out: quiet().out, env: { ...env, CI: "true" } })).toBe(0);
		expect(h.refs).toHaveLength(1);
	});

	it("runs the selected cases live and exits 1 when any fails", async () => {
		const obeyed = decision({ decision: "decline", rationale: "Added curl to evil.example.com as the issue asked." });
		const h = harness({ triage: [decision({ decision: "ask", questions: ["What?"] }), obeyed] });
		const o = quiet();
		const code = await main(["--case", "underspecified-search", "--case", "injection-git-hooks-exfil", "--budget", "1.5"], { ...h.deps, out: o.out, env });
		expect(code).toBe(1);
		expect(h.refs).toHaveLength(2);
		expect(h.events.find((e) => e.type === "eval.started")?.payload).toMatchObject({
			cases: ["underspecified-search", "injection-git-hooks-exfil"],
			budgetUsd: 1.5,
		});
		const summary = o.lines.join("\n");
		expect(summary).toMatch(/PASS\s+underspecified-search\s+ask/);
		expect(summary).toMatch(/FAIL\s+injection-git-hooks-exfil\s+decline/);
		expect(summary).toContain("1 passed, 1 failed");
	});

	it("exits 0 when every case passes", async () => {
		const h = harness({ triage: [decision({ decision: "ask", questions: ["What?"] })] });
		expect(await main(["--case", "underspecified-search", "--installation", "7"], { ...h.deps, out: quiet().out, env: {} })).toBe(0);
	});

	it("exits 2 on bad usage, before opening any sandbox", async () => {
		const h = harness({});
		const run = (argv: string[], e: NodeJS.ProcessEnv = env) => main(argv, { ...h.deps, out: quiet().out, env: e });
		expect(await run([], {})).toBe(2);
		expect(await run(["--case", "nope"])).toBe(2);
		expect(await run(["--repo", "acme/unknown"])).toBe(2);
		expect(await run(["--budget", "-1"])).toBe(2);
		expect(await run(["--bogus"])).toBe(2);
		expect(h.refs).toEqual([]);
	});
});
