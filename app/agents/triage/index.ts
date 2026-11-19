import { TriageDecision } from "../../schemas/index.js";
import { defineAgent } from "../define.js";
import { piSonnet } from "../models.js";

export const triage = defineAgent({
	id: "triage",
	prompt: "triage/prompt.md",
	harness: piSonnet,
	tools: ["read", "ls", "bash"],
	output: TriageDecision,
	maxTurns: 40,
});
