import { Implementation } from "../../schemas/index.js";
import { defineAgent } from "../define.js";
import { piOpus } from "../models.js";

/**
 * Implements the approved spec in the sandbox's working tree and runs the verify commands itself. A repair run
 * is the same agent with the failing verify output in its message.
 */
export const implementer = defineAgent({
	id: "implementer",
	prompt: "implementer/prompt.md",
	harness: piOpus,
	tools: ["read", "ls", "bash", "edit", "write"],
	output: Implementation,
	maxTurns: 150,
});
