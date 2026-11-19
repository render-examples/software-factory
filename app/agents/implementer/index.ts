import { Implementation } from "../../schemas/index.js";
import { defineAgent } from "../define.js";
import { piOpus } from "../models.js";

export const implementer = defineAgent({
	id: "implementer",
	prompt: "implementer/prompt.md",
	harness: piOpus,
	tools: ["read", "ls", "bash", "edit", "write"],
	output: Implementation,
	maxTurns: 150,
});
