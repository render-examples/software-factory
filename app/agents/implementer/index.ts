import type { RepoConfig } from "../../config/index.js";
import { Implementation } from "../../schemas/index.js";
import { defineAgent } from "../define.js";

/** Placeholders in prompt.md. `repo`: "owner/name"; `verifyCommands`: see {@link verifyCommandsVar}. */
export const implementerVars = ["repo", "verifyCommands"] as const;

/**
 * Implements the approved spec in the sandbox's working tree and runs the verify commands itself. A repair run
 * is the same agent with the failing verify output in its message.
 */
export const implementer = defineAgent({
	id: "implementer",
	prompt: "implementer/prompt.md",
	model: "large",
	tools: ["read", "ls", "bash", "edit", "write"],
	output: Implementation,
	maxTurns: 150,
});

/** The `verifyCommands` var: the repository's verify commands as a Markdown list of code spans. */
export function verifyCommandsVar(verify: RepoConfig["verify"]): string {
	if (verify.length === 0) return "- (none configured: check your work by reading it and running the relevant tests)";
	return verify.map((command) => `- ${codeSpan(command)}`).join("\n");
}

function codeSpan(text: string): string {
	const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longestRun + 1);
	return longestRun > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}
