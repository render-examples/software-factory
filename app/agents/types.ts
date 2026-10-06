import type { ModelTier, RunnerName } from "../../factory.config.js";
import type { Tool } from "../tools/index.js";

export interface Agent {
	/** Also the registered Render task name. Must be unique and stable. */
	readonly id: string;
	readonly description?: string;
	readonly model: ModelTier;
	readonly prompt: string;
	readonly tools?: readonly Tool[];
	readonly maxTurns?: number;
	/** Render Workflows instance plan. */
	readonly plan?: string;
	/** Overrides `factoryConfig.agents.runner` for this agent. */
	readonly runner?: RunnerName;
	/** When true, browser tools may be injected at runtime via agentTask. */
	readonly browser?: true;
}
