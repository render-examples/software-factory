import { SpecDraft } from "../../schemas/index.js";
import { defineAgent } from "../define.js";
import { piOpus } from "../models.js";

export const specWriter = defineAgent({
	id: "spec-writer",
	prompt: "spec-writer/prompt.md",
	harness: piOpus,
	tools: ["read", "ls", "bash"],
	output: SpecDraft,
	maxTurns: 60,
});
