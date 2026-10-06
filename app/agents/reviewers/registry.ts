import type { Agent } from "../types.js";
import { correctnessReviewer } from "./correctness-reviewer.js";
import { performanceReviewer } from "./performance-reviewer.js";
import { securityReviewer } from "./security-reviewer.js";
import { testsReviewer } from "./tests-reviewer.js";

/**
 * Maps config specialist names to agent definitions.
 * Adding a specialist: create the agent file and add one entry here.
 */
const SPECIALIST_REGISTRY: Record<string, Agent> = {
	security: securityReviewer,
	correctness: correctnessReviewer,
	performance: performanceReviewer,
	tests: testsReviewer,
};

/** Resolve config names to agents. Throws on unknown names. */
export function resolveSpecialists(names: readonly string[]): Agent[] {
	const agents: Agent[] = [];
	for (const name of names) {
		const agent = SPECIALIST_REGISTRY[name];
		if (!agent) {
			const known = Object.keys(SPECIALIST_REGISTRY).join(", ");
			throw new Error(
				`Unknown specialist "${name}" in review.specialists. Known: ${known}`,
			);
		}
		agents.push(agent);
	}
	return agents;
}

export function knownSpecialistNames(): string[] {
	return Object.keys(SPECIALIST_REGISTRY);
}
