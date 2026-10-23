import { type RunAgentOptions, type runAgent, specWriter, triage } from "../../agents/index.js";
import type { SpecDraft, TriageDecision } from "../../schemas/index.js";

export type AgentRunner = typeof runAgent;

/** Triage's two agents, bound to one sandbox. */
export function triageAgents(run: AgentRunner, opts: RunAgentOptions) {
	return {
		async triage(message: string): Promise<TriageDecision> {
			return (await run(triage, message, opts)).output;
		},
		async specWriter(message: string): Promise<SpecDraft> {
			return (await run(specWriter, message, opts)).output;
		},
	};
}

export type TriageAgents = ReturnType<typeof triageAgents>;
