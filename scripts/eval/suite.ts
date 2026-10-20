import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	AgentError,
	implementationReviewer,
	implementer,
	prReviewer,
	type runAgent,
	specWriter,
	triage,
	verifyCommandsVar,
} from "../../app/agents/index.js";
import { config, type RepoContext } from "../../app/config/index.js";
import type { Implementation } from "../../app/schemas/index.js";
import type { FactoryEvent } from "../../app/events/index.js";
import { renderSpec } from "../../app/format/index.js";
import type { Issue, IssueComment, PullFile, PullRequest } from "../../app/github/index.js";
import { Budget } from "../../app/runs/budget.js";
import { type OpenedSandbox, SCRATCH_DIR, type SandboxRef } from "../../app/sandbox/index.js";
import { implementationReviewMessage, implementMessage } from "../../app/workflows/spec-to-pr/agents.js";
import { runVerify as runImplementationVerify } from "../../app/workflows/spec-to-pr/verify.js";
import { reviewPull } from "../../app/workflows/pr-review/agents.js";
import { reviewerMessage } from "../../app/workflows/pr-review/messages.js";
import { runVerify as runPrVerify } from "../../app/workflows/pr-review/verify.js";
import { type AgentRunner, triageAgents } from "../../app/workflows/triage/agents.js";
import { draftSpec } from "../../app/workflows/triage/spec.js";
import { readThread, specWriterMessage, triageMessage } from "../../app/workflows/triage/thread.js";
import { CASES_DIR, type EvalCase, type EvalFixture } from "./case.js";
import { type CaseOutcome, type Grade, gradeCase } from "./grade.js";

/** The factory's bot login in replayed threads. */
export const EVAL_BOT = "software-factory-eval[bot]";

export interface EvalDeps {
	repo: RepoContext;
	openSandbox: (repo: RepoContext, ref: SandboxRef) => Promise<OpenedSandbox>;
	runAgent: typeof runAgent;
	emit: (event: FactoryEvent) => Promise<void>;
	budgetUsd: number;
	fixture: EvalFixture;
	trials?: number;
	traceId?: string;
	log?: (line: string) => void;
	now?: () => number;
}

export interface TrialResult extends Grade {
	trial: number;
	decision?: string;
	costUsd: number;
	durationMs: number;
	error?: string;
	fixtureSha?: string;
}

export interface CaseResult extends Grade {
	id: string;
	stage: EvalCase["stage"];
	decision?: string;
	costUsd: number;
	durationMs: number;
	trials: TrialResult[];
	passedTrials: number;
	passRate: number;
	error?: string;
}

export interface EvalRun {
	schemaVersion: 1;
	traceId: string;
	results: CaseResult[];
	passed: number;
	failed: number;
	costUsd: number;
	metadata: {
		repo: string;
		baseBranch: string;
		expectedFixtureSha: string;
		actualFixtureShas: string[];
		runnerHashes: string[];
		models: typeof config.models;
		promptHashes: Record<string, string>;
		trials: number;
	};
}

/** Runs every case and trial serially because sandbox creation is rate-limited. */
export async function runEvals(cases: readonly EvalCase[], deps: EvalDeps): Promise<EvalRun> {
	const traceId = deps.traceId ?? `eval-${randomUUID()}`;
	const trialCount = deps.trials ?? 1;
	if (!Number.isSafeInteger(trialCount) || trialCount <= 0) throw new Error("eval trials must be a positive integer");
	const now = deps.now ?? Date.now;
	const started = now();
	const record = (type: string, payload: Record<string, unknown>, subject?: string) =>
		deps.emit({ traceId, repo: deps.repo.fullName, subject, type, payload }).catch(() => {});

	await record("eval.started", { cases: cases.map((c) => c.id), budgetUsd: deps.budgetUsd, trials: trialCount });
	const results: CaseResult[] = [];
	const fixtureShas = new Set<string>();
	const runnerHashes = new Set<string>();

	for (const evalCase of cases) {
		const caseStarted = now();
		const trials: TrialResult[] = [];
		for (let trial = 1; trial <= trialCount; trial++) {
			deps.log?.(`running ${evalCase.id}${trialCount === 1 ? "" : ` (trial ${trial}/${trialCount})`}`);
			const trialStarted = now();
			const outcome = await runCase(evalCase, traceId, trial, deps);
			const grade = gradeCase(evalCase, outcome);
			if (outcome.fixtureSha) fixtureShas.add(outcome.fixtureSha);
			if (outcome.runnerHash) runnerHashes.add(outcome.runnerHash);
			const result: TrialResult = {
				trial,
				...grade,
				decision: outcome.decision?.decision,
				costUsd: outcome.costUsd,
				durationMs: now() - trialStarted,
				...(outcome.error ? { error: outcome.error } : {}),
				...(outcome.fixtureSha ? { fixtureSha: outcome.fixtureSha } : {}),
			};
			trials.push(result);
			await record(
				"eval.case",
				{
					caseId: evalCase.id,
					stage: evalCase.stage,
					trial,
					pass: result.pass,
					reasons: result.reasons,
					decision: result.decision ?? null,
					questions: outcome.decision?.questions ?? [],
					specTitle: outcome.draft?.spec.title ?? null,
					changedFiles: outcome.changedFiles ?? [],
					costUsd: result.costUsd,
					durationMs: result.durationMs,
					fixtureSha: outcome.fixtureSha ?? null,
					...(result.error ? { error: result.error } : {}),
				},
				caseSubject(evalCase, trial),
			);
		}
		const passedTrials = trials.filter((trial) => trial.pass).length;
		const failed = trials.filter((trial) => !trial.pass);
		results.push({
			id: evalCase.id,
			stage: evalCase.stage,
			pass: failed.length === 0,
			reasons:
				trials.length === 1
					? failed.flatMap((trial) => trial.reasons)
					: failed.flatMap((trial) => trial.reasons.map((reason) => `trial ${trial.trial}: ${reason}`)),
			decision: unanimousDecision(trials),
			costUsd: trials.reduce((sum, trial) => sum + trial.costUsd, 0),
			durationMs: now() - caseStarted,
			trials,
			passedTrials,
			passRate: passedTrials / trials.length,
			...(failed.find((trial) => trial.error)?.error ? { error: failed.find((trial) => trial.error)?.error } : {}),
		});
	}

	const passed = results.filter((result) => result.pass).length;
	const run: EvalRun = {
		schemaVersion: 1,
		traceId,
		results,
		passed,
		failed: results.length - passed,
		costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
		metadata: {
			repo: deps.repo.fullName,
			baseBranch: deps.repo.config.baseBranch,
			expectedFixtureSha: deps.fixture.sha,
			actualFixtureShas: [...fixtureShas].sort(),
			runnerHashes: [...runnerHashes].sort(),
			models: config.models,
			promptHashes: promptHashes(),
			trials: trialCount,
		},
	};
	await record("eval.finished", {
		passed,
		failed: run.failed,
		costUsd: run.costUsd,
		trials: trialCount,
		durationMs: now() - started,
	});
	return run;
}

interface ObservedOutcome extends CaseOutcome {
	runnerHash?: string;
}

async function runCase(evalCase: EvalCase, traceId: string, trial: number, deps: EvalDeps): Promise<ObservedOutcome> {
	const outputs: CaseOutcome["outputs"] = [];
	const budget = new Budget(deps.budgetUsd);
	let sandbox: OpenedSandbox | undefined;
	const outcome = (rest: Partial<ObservedOutcome> = {}): ObservedOutcome => ({
		outputs,
		costUsd: budget.spent,
		fixtureSha: sandbox?.headSha,
		runnerHash: sandbox?.manifest.runnerHash,
		...rest,
	});
	try {
		sandbox = await deps.openSandbox(deps.repo, { kind: "branch", name: deps.repo.config.baseBranch });
	} catch (error) {
		return outcome({ error: `could not open a sandbox: ${message(error)}` });
	}

	try {
		assertFixture(deps, sandbox);
		const recording = recordingRunner(deps.runAgent, outputs);
		const base: EvalBase = {
			sandbox,
			traceId,
			runId: `${traceId}/${evalCase.id}/${trial}`,
			repo: deps.repo.fullName,
			subject: caseSubject(evalCase, trial),
		};
		switch (evalCase.stage) {
			case "triage":
				return outcome(await runTriageCase(evalCase, deps, recording, base, budget));
			case "implementation":
				return outcome(await runImplementationCase(evalCase, deps, recording, base, budget));
			case "implementation-review":
				return outcome(await runImplementationReviewCase(evalCase, deps, recording, base, budget));
			case "pr-review":
				return outcome(await runPrReviewCase(evalCase, deps, recording, base, budget));
		}
	} catch (error) {
		return outcome({ error: message(error) });
	} finally {
		await sandbox.close().catch((error: unknown) => deps.log?.(`warning: could not close sandbox ${sandbox?.id}: ${message(error)}`));
	}
}

type EvalRunner = typeof runAgent;
type EvalBase = {
	sandbox: OpenedSandbox;
	traceId: string;
	runId: string;
	repo: string;
	subject: string;
};

async function runTriageCase(
	evalCase: Extract<EvalCase, { stage: "triage" }>,
	deps: EvalDeps,
	recording: EvalRunner,
	base: EvalBase,
	budget: Budget,
): Promise<Partial<CaseOutcome>> {
	const thread = readThread(caseIssue(evalCase), caseComments(evalCase), EVAL_BOT);
	const agents = triageAgents(recording as AgentRunner, { ...base, budget });
	const decision = await agents.triage(triageMessage(deps.repo.fullName, thread));
	if (decision.decision !== "draft") return { decision };
	const drafted = await draftSpec(agents, base.sandbox, specWriterMessage(deps.repo.fullName, thread, decision));
	return {
		decision,
		draft: drafted.draft,
		renderedSpec: renderSpec(drafted.draft.spec, { version: 1, warnings: drafted.warnings }),
	};
}

async function runImplementationCase(
	evalCase: Extract<EvalCase, { stage: "implementation" }>,
	deps: EvalDeps,
	recording: EvalRunner,
	base: EvalBase,
	budget: Budget,
): Promise<Partial<CaseOutcome>> {
	const issue = { number: 1, title: evalCase.issue.title };
	const vars = { repo: deps.repo.fullName, verifyCommands: verifyCommandsVar(deps.repo.config.verify) };
	const run = await budget.track((budgetUsd) =>
		recording(implementer, { message: implementMessage(issue, evalCase.spec), vars }, { ...base, budgetUsd, timeoutMs: 60 * 60 * 1000 }),
	);
	const production = await runImplementationVerify(base.sandbox, deps.repo.config.verify);
	const hidden = await runChecks(base.sandbox, evalCase.expect.commands ?? []);
	const checks = [
		...production.map((check) => ({ command: check.command, passed: check.passed, output: check.output })),
		...hidden,
	];
	const workspace = await inspectWorkspace(base.sandbox, base.sandbox.headSha);
	return { implementation: run.output, checks, ...workspace };
}

async function runImplementationReviewCase(
	evalCase: Extract<EvalCase, { stage: "implementation-review" }>,
	deps: EvalDeps,
	recording: EvalRunner,
	base: EvalBase,
	budget: Budget,
): Promise<Partial<CaseOutcome>> {
	await applyPatch(base.sandbox, evalCase.fixture.patch);
	const workspace = await inspectWorkspace(base.sandbox, base.sandbox.headSha);
	const implementation: Implementation = {
		summary: evalCase.implementationSummary,
		filesChanged: workspace.changedFiles,
		verification: [],
		followUps: [],
	};
	const task = implementationReviewMessage({ number: 1, title: evalCase.issue.title }, evalCase.spec, implementation);
	const run = await budget.track((budgetUsd) =>
		recording(
			implementationReviewer,
			{ message: task, vars: { repo: deps.repo.fullName, baseRef: base.sandbox.headSha } },
			{ ...base, budgetUsd },
		),
	);
	return { implementation, implementationReview: run.output, ...workspace };
}

async function runPrReviewCase(
	evalCase: Extract<EvalCase, { stage: "pr-review" }>,
	deps: EvalDeps,
	recording: EvalRunner,
	base: EvalBase,
	budget: Budget,
): Promise<Partial<CaseOutcome>> {
	await applyPatch(base.sandbox, evalCase.fixture.patch);
	const workspace = await inspectWorkspace(base.sandbox, base.sandbox.headSha);
	const verify = await runPrVerify(base.sandbox, deps.repo.config.verify);
	const pull = evalPull(evalCase, base.sandbox.headSha, deps.repo.config.baseBranch);
	const files = pullFiles(workspace.changedFiles);
	const { sandbox: _sandbox, ...agentBase } = base;
	const review = await reviewPull(recording, {
		sandbox: base.sandbox,
		message: reviewerMessage(pull, files, verify),
		vars: { repo: deps.repo.fullName, baseRef: base.sandbox.headSha },
		budget,
		base: agentBase,
	});
	return { review, ...workspace };
}

function recordingRunner(delegate: EvalRunner, outputs: CaseOutcome["outputs"]): EvalRunner {
	return (async (agent, input, opts) => {
		try {
			const run = await delegate(agent, input, opts);
			outputs.push({ agentId: agent.id, output: run.output, trace: run.trace });
			return run;
		} catch (error) {
			outputs.push({
				agentId: agent.id,
				...(error instanceof AgentError ? { trace: error.trace } : {}),
				error: message(error),
			});
			throw error;
		}
	}) as EvalRunner;
}

function assertFixture(deps: EvalDeps, sandbox: OpenedSandbox): void {
	if (deps.fixture.repo !== deps.repo.fullName) throw new Error(`eval fixture is for ${deps.fixture.repo}, not ${deps.repo.fullName}`);
	if (deps.fixture.baseBranch !== deps.repo.config.baseBranch) {
		throw new Error(`eval fixture expects branch ${deps.fixture.baseBranch}, not ${deps.repo.config.baseBranch}`);
	}
	if (sandbox.headSha !== deps.fixture.sha) {
		throw new Error(`fixture drift: expected ${deps.fixture.sha}, opened ${sandbox.headSha}; update evals/fixture.json intentionally`);
	}
}

async function applyPatch(sandbox: OpenedSandbox, relative: string): Promise<void> {
	const data = await readFile(join(CASES_DIR, relative));
	const remote = `${SCRATCH_DIR}/eval-${randomUUID()}.patch`;
	await sandbox.upload(remote, data);
	try {
		const applied = await sandbox.exec(`git apply --whitespace=nowarn ${remote}`, { asRunner: true });
		if (applied.exitCode !== 0) throw new Error(`fixture patch ${relative} failed: ${tail(applied.stderr || applied.stdout)}`);
	} finally {
		await sandbox.exec(`rm -f ${remote}`).catch(() => {});
	}
}

async function inspectWorkspace(sandbox: OpenedSandbox, baseSha: string): Promise<{ diff: string; changedFiles: string[] }> {
	const intent = await sandbox.exec("git add -N -- .", { asRunner: true });
	if (intent.exitCode !== 0) throw new Error(`could not inspect untracked files: ${tail(intent.stderr)}`);
	const [diff, names] = await Promise.all([
		sandbox.exec(`git diff --no-ext-diff --binary ${baseSha}`, { asRunner: true }),
		sandbox.exec(`git diff --name-only -z ${baseSha}`, { asRunner: true }),
	]);
	if (diff.exitCode !== 0) throw new Error(`git diff failed: ${tail(diff.stderr)}`);
	if (names.exitCode !== 0) throw new Error(`git diff --name-only failed: ${tail(names.stderr)}`);
	return { diff: diff.stdout, changedFiles: names.stdout.split("\0").filter(Boolean).sort() };
}

async function runChecks(
	sandbox: OpenedSandbox,
	commands: readonly string[],
): Promise<Array<{ command: string; passed: boolean; output: string }>> {
	const checks: Array<{ command: string; passed: boolean; output: string }> = [];
	for (const command of commands) {
		const result = await sandbox.exec(command, { asRunner: true, timeoutMs: 10 * 60 * 1000 });
		checks.push({
			command,
			passed: result.exitCode === 0,
			output: tail([result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n"), 2_000),
		});
	}
	return checks;
}

function pullFiles(changedFiles: readonly string[]): PullFile[] {
	return changedFiles.map((filename) => ({
		filename,
		status: "modified",
		additions: 0,
		deletions: 0,
		changes: 0,
	}));
}

function evalPull(evalCase: Extract<EvalCase, { stage: "pr-review" }>, sha: string, baseBranch: string): PullRequest {
	return {
		number: 1,
		state: "open",
		draft: false,
		merged: false,
		title: evalCase.pull.title,
		body: evalCase.pull.body,
		headSha: sha,
		headRef: "eval",
		headRepo: null,
		baseRef: baseBranch,
		baseSha: sha,
		htmlUrl: "",
	};
}

export function caseIssue(evalCase: Extract<EvalCase, { stage: "triage" }>): Issue {
	return {
		number: 1,
		title: evalCase.issue.title,
		body: evalCase.issue.body,
		state: "open",
		labels: evalCase.issue.labels ?? [],
		author: { login: "eval-reporter", type: "User" },
		isPull: false,
		htmlUrl: "",
	};
}

export function caseComments(evalCase: Extract<EvalCase, { stage: "triage" }>): IssueComment[] {
	return (evalCase.comments ?? []).map((comment, i) => ({
		id: i + 1,
		body: comment.body,
		author: { login: comment.author, type: comment.bot ? "Bot" : "User" },
		performedViaApp: null,
		createdAt: "",
		updatedAt: "",
		htmlUrl: "",
	}));
}

function promptHashes(): Record<string, string> {
	return Object.fromEntries(
		[triage, specWriter, implementer, implementationReviewer, prReviewer].map((agent) => [
			agent.id,
			createHash("sha256").update(agent.prompt).digest("hex"),
		]),
	);
}

function unanimousDecision(trials: readonly TrialResult[]): string | undefined {
	const decisions = new Set(trials.map((trial) => trial.decision).filter((decision): decision is string => Boolean(decision)));
	return decisions.size === 1 ? [...decisions][0] : undefined;
}

const caseSubject = (evalCase: EvalCase, trial: number) => `eval:${evalCase.id}:trial:${trial}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const tail = (text: string, max = 500) => (text.length > max ? `…${text.slice(-max)}` : text).trim();
