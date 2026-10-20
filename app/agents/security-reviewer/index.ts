import { SpecialistReport } from "../../contracts/index.js";
import { defineAgent } from "../define.js";

/** Reviews a pull request for exploitable vulnerabilities. Read-only, in the PR Reviewer's sandbox. */
export const securityReviewer = defineAgent({
	id: "security-reviewer",
	prompt: "security-reviewer/prompt.md",
	model: "medium",
	tools: ["read", "ls", "bash"],
	output: SpecialistReport,
	maxTurns: 60,
});
