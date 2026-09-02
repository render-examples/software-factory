import type { ModelTier } from "../../factory.config.js";
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
}
