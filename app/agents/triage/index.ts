import { TriageDecision } from "../../contracts/index.js";
import { defineAgent } from "../define.js";

/** Placeholders in prompt.md. `repo`: "owner/name". */
export const triageVars = ["repo"] as const;

/** Reads the repository (read-only) and decides whether the issue is ready for a spec. Runs in a sandbox at the base branch. */
export const triage = defineAgent({
	id: "triage",
	prompt: "triage/prompt.md",
	model: "medium",
	tools: ["read", "ls", "bash"],
	output: TriageDecision,
	maxTurns: 40,
});
