import { AgentError, type AgentErrorCode, type runAgent, specWriter, triage } from "../../agents/index.js";
import type { SpecDraft, TriageDecision } from "../../contracts/index.js";
import { type Budget, PhaseError } from "../../phases/index.js";
import type { Sandbox } from "../../sandbox/index.js";

export type AgentRunner = typeof runAgent;

export interface TriageAgentOptions {
	sandbox: Sandbox;
	traceId: string;
	runId: string;
	repo: string;
	subject: string;
	/** The run's budget, shared by every agent call. */
	budget: Budget;
}

/** Failures that come from the model or its limits; anything else is the platform's and fails the task. */
const EXPECTED: Partial<Record<AgentErrorCode, string>> = {
	budget_exceeded: "spent the run's budget",
	max_turns: "ran out of turns",
	timeout: "timed out",
	no_submission: "ended without submitting a result",
	invalid_submission: "submitted an invalid result",
	output_invalid: "submitted an invalid result",
};

/** Triage's two agents in one sandbox, sharing the run's budget: each call gets what the run has left. */
export function triageAgents(run: AgentRunner, opts: TriageAgentOptions) {
	const { budget, ...base } = opts;
	const vars = { repo: opts.repo };

	const track = async <T extends { costUsd: number }>(agentId: string, call: (budgetUsd: number) => Promise<T>): Promise<T> => {
		try {
			return await budget.track(call);
		} catch (error) {
			if (!(error instanceof AgentError)) throw error;
			const reason = EXPECTED[error.code];
			if (reason) throw new PhaseError(`the ${agentId} agent ${reason}.`, error.code === "budget_exceeded" ? "budget-exceeded" : "agent-failed");
			throw error;
		}
	};

	return {
		async triage(message: string): Promise<TriageDecision> {
			return (await track(triage.id, (budgetUsd) => run(triage, { message, vars }, { ...base, budgetUsd }))).output;
		},
		async specWriter(message: string): Promise<SpecDraft> {
			return (await track(specWriter.id, (budgetUsd) => run(specWriter, { message, vars }, { ...base, budgetUsd }))).output;
		},
	};
}

export type TriageAgents = ReturnType<typeof triageAgents>;
