import { AgentError, type AgentErrorCode, type runAgent, specWriter, triage } from "../../agents/index.js";
import type { SpecDraft, TriageDecision } from "../../schemas/index.js";
import { RunError } from "../../runs/index.js";
import type { Sandbox } from "../../sandbox/index.js";

export type AgentRunner = typeof runAgent;

export interface TriageAgentOptions {
	sandbox: Sandbox;
	traceId: string;
	runId: string;
	repo: string;
	subject: string;
}

/** Failures that come from the model or its limits; anything else is the platform's and fails the task. */
const EXPECTED: Partial<Record<AgentErrorCode, string>> = {
	max_turns: "ran out of turns",
	timeout: "timed out",
	no_submission: "ended without submitting a result",
	invalid_submission: "submitted an invalid result",
	output_invalid: "submitted an invalid result",
};

/** Triage's two agents in one sandbox. */
export function triageAgents(run: AgentRunner, opts: TriageAgentOptions) {
	const expected = async <T>(agentId: string, call: () => Promise<T>): Promise<T> => {
		try {
			return await call();
		} catch (error) {
			if (!(error instanceof AgentError)) throw error;
			const reason = EXPECTED[error.code];
			if (reason) throw new RunError(`the ${agentId} agent ${reason}.`, "agent-failed");
			throw error;
		}
	};

	return {
		async triage(message: string): Promise<TriageDecision> {
			return (await expected(triage.id, () => run(triage, message, opts))).output;
		},
		async specWriter(message: string): Promise<SpecDraft> {
			return (await expected(specWriter.id, () => run(specWriter, message, opts))).output;
		},
	};
}

export type TriageAgents = ReturnType<typeof triageAgents>;
