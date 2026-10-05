import { factoryConfig, type RunnerName } from "../../factory.config.js";
import type { Agent } from "../agents/types.js";
import { claudeRunner } from "./claude.js";
import { openaiRunner } from "./openai.js";
import type { AgentRunner } from "./types.js";

export type {
	AgentRunner,
	RunnerResult,
	RunnerUsage,
} from "./types.js";
export { claudeRunner } from "./claude.js";
export { openaiRunner } from "./openai.js";
export { parseModelJson } from "./json.js";
export { md } from "./md.js";
export {
	usageTotals,
	failureReason,
	isRecord,
	type UsageTotals,
} from "./messages.js";

const RUNNERS: Record<RunnerName, AgentRunner> = {
	claude: claudeRunner,
	openai: openaiRunner,
};

/** Resolve the runner for an agent: per-agent override or config default. */
export function resolveRunner(agent: Agent): AgentRunner {
	const name = agent.runner ?? factoryConfig.agents.runner;
	const runner = RUNNERS[name];
	if (!runner) throw new Error(`Unknown runner: ${name}`);
	return runner;
}
