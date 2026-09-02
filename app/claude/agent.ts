import type { ModelTier } from "../../factory.config.js";
import type { Tool } from "../tools/index.js";

/**
 * What an agent is: a prompt, a model tier, and the tools it may call.
 *
 * Turning one into a Render Workflows task is app/tasks — this file stays free
 * of the workflows SDK so app/agents can import it without pulling in
 * registration.
 */
export interface Agent {
	/** Also the registered Render task name. Keep it unique and stable. */
	readonly id: string;
	readonly description?: string;
	readonly model: ModelTier;
	readonly prompt: string;
	/** Omit for agents that only reason about their input. */
	readonly tools?: readonly Tool[];
	readonly maxTurns?: number;
	/** Render Workflows instance plan for this agent's task. */
	readonly plan?: string;
}
