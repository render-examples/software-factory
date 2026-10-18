import { randomUUID } from "node:crypto";
import type { RepoContext } from "../../app/config/index.js";
import type { FactoryEvent } from "../../app/events/index.js";
import { renderSpec } from "../../app/format/index.js";
import type { Issue, IssueComment } from "../../app/github/index.js";
import { Budget } from "../../app/phases/budget.js";
import type { Sandbox, SandboxRef } from "../../app/sandbox/index.js";
import { type AgentRunner, triageAgents } from "../../app/workflows/triage/agents.js";
import { draftSpec } from "../../app/workflows/triage/spec.js";
import { readThread, specWriterMessage, triageMessage } from "../../app/workflows/triage/thread.js";
import type { EvalCase } from "./case.js";
import { type CaseOutcome, type Grade, gradeCase } from "./grade.js";

/** The factory's bot login in replayed threads. No case comment uses it, so none is read as the factory's own. */
export const EVAL_BOT = "software-factory-eval[bot]";
/** Replayed issues have no real number; every case uses this one. */
export const EVAL_ISSUE_NUMBER = 1;

export interface EvalDeps {
	repo: RepoContext;
	openSandbox: (repo: RepoContext, ref: SandboxRef) => Promise<Sandbox>;
	runAgent: AgentRunner;
	emit: (event: FactoryEvent) => Promise<void>;
	/** Dollars each case may spend across its agent calls. */
	budgetUsd: number;
	/** Default: a fresh `eval-<uuid>`. */
	traceId?: string;
	/** Progress lines, one per case. */
	log?: (line: string) => void;
	now?: () => number;
}

export interface CaseResult extends Grade {
	id: string;
	decision?: string;
	costUsd: number;
	durationMs: number;
	error?: string;
}

export interface EvalRun {
	traceId: string;
	results: CaseResult[];
	passed: number;
	failed: number;
	costUsd: number;
}

/** Runs `cases` one after another (each opens a sandbox, and the Sandbox API is rate-limited), recording one trace. */
export async function runEvals(cases: readonly EvalCase[], deps: EvalDeps): Promise<EvalRun> {
	const traceId = deps.traceId ?? `eval-${randomUUID()}`;
	const now = deps.now ?? Date.now;
	const started = now();
	const record = (type: string, payload: Record<string, unknown>, subject?: string) =>
		deps.emit({ traceId, repo: deps.repo.fullName, subject, type, payload }).catch(() => {});

	await record("eval.started", { cases: cases.map((c) => c.id), budgetUsd: deps.budgetUsd });
	const results: CaseResult[] = [];
	for (const c of cases) {
		deps.log?.(`running ${c.id}`);
		const caseStarted = now();
		const outcome = await runCase(c, traceId, deps);
		const grade = gradeCase(c.expect, outcome);
		const result: CaseResult = {
			id: c.id,
			...grade,
			decision: outcome.decision?.decision,
			costUsd: outcome.costUsd,
			durationMs: now() - caseStarted,
			...(outcome.error ? { error: outcome.error } : {}),
		};
		results.push(result);
		await record(
			"eval.case",
			{
				caseId: c.id,
				pass: result.pass,
				reasons: result.reasons,
				decision: result.decision ?? null,
				questions: outcome.decision?.questions ?? [],
				specTitle: outcome.draft?.spec.title ?? null,
				costUsd: result.costUsd,
				durationMs: result.durationMs,
				...(result.error ? { error: result.error } : {}),
			},
			caseSubject(c),
		);
	}

	const passed = results.filter((r) => r.pass).length;
	const costUsd = results.reduce((sum, r) => sum + r.costUsd, 0);
	const run = { traceId, results, passed, failed: results.length - passed, costUsd };
	await record("eval.finished", { passed, failed: run.failed, costUsd, durationMs: now() - started });
	return run;
}

/**
 * Replays one case the way the triage phase runs an issue, minus GitHub: the same thread, the same messages, the
 * same agents sharing one budget in one sandbox at the base branch, and the same spec validation and retry.
 */
export async function runCase(c: EvalCase, traceId: string, deps: EvalDeps): Promise<CaseOutcome> {
	const outputs: CaseOutcome["outputs"] = [];
	const budget = new Budget(deps.budgetUsd);
	const outcome = (rest: Partial<CaseOutcome> = {}): CaseOutcome => ({ outputs, costUsd: budget.spent, ...rest });
	const { repo } = deps;
	const thread = readThread(caseIssue(c), caseComments(c), EVAL_BOT);

	let sandbox: Sandbox;
	try {
		sandbox = await deps.openSandbox(repo, { kind: "branch", name: repo.config.baseBranch });
	} catch (error) {
		return outcome({ error: `could not open a sandbox: ${message(error)}` });
	}

	const recording: AgentRunner = async (agent, input, opts) => {
		const run = await deps.runAgent(agent, input, opts);
		outputs.push({ agentId: agent.id, output: run.output });
		return run;
	};
	const agents = triageAgents(recording, {
		sandbox,
		traceId,
		runId: `${traceId}/${c.id}`,
		repo: repo.fullName,
		subject: caseSubject(c),
		budget,
	});

	let decision: CaseOutcome["decision"];
	try {
		decision = await agents.triage(triageMessage(repo.fullName, thread));
		if (decision.decision !== "draft") return outcome({ decision });
		const drafted = await draftSpec(agents, sandbox, specWriterMessage(repo.fullName, thread, decision));
		const renderedSpec = renderSpec(drafted.draft.spec, { version: 1, warnings: drafted.warnings });
		return outcome({ decision, draft: drafted.draft, renderedSpec });
	} catch (error) {
		return outcome({ decision, error: message(error) });
	} finally {
		await sandbox.close().catch((error: unknown) => deps.log?.(`warning: could not close sandbox ${sandbox.id}: ${message(error)}`));
	}
}

export function caseIssue(c: EvalCase): Issue {
	return {
		number: EVAL_ISSUE_NUMBER,
		title: c.issue.title,
		body: c.issue.body,
		state: "open",
		labels: c.issue.labels ?? [],
		author: { login: "eval-reporter", type: "User" },
		isPull: false,
		htmlUrl: "",
	};
}

export function caseComments(c: EvalCase): IssueComment[] {
	return (c.comments ?? []).map((comment, i) => ({
		id: i + 1,
		body: comment.body,
		author: { login: comment.author, type: comment.bot ? "Bot" : "User" },
		performedViaApp: null,
		createdAt: "",
		updatedAt: "",
		htmlUrl: "",
	}));
}

export const caseSubject = (c: EvalCase) => `eval:${c.id}`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
