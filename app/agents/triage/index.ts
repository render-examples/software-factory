import { TriageDecision } from "../../schemas/index.js";
import { defineAgent } from "../define.js";
import { piSonnet } from "../models.js";

/** Reads the repository (read-only) and decides whether the issue is ready for a spec. Runs in a sandbox at the base branch. */
export const triage = defineAgent({
	id: "triage",
	prompt: "triage/prompt.md",
	harness: piSonnet,
	tools: ["read", "ls", "bash"],
	output: TriageDecision,
	maxTurns: 40,
});
