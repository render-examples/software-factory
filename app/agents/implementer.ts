import { factoryConfig } from "../../factory.config.js";
import { type Agent, md } from "../claude/index.js";
import { allTools } from "../tools/index.js";

export const implementer: Agent = {
	id: "implementer",
	description: "Implements the approved plan in an isolated sandbox",
	model: "large",
	tools: allTools,
	maxTurns: 60,
	plan: "standard",
	prompt: md`
		You are the implementation agent. Implement the supplied plan in the
		checkout at ${factoryConfig.repoDir}. Do not commit, push, or run
		verification commands; the workflow owns Git and verification.

		Write correct code that follows the repository's existing patterns and
		conventions. When you receive verification failures, fix only the issues
		named in the failure output — do not restructure unrelated code.

		Respond ONLY with JSON:
		{ "summary": string }
	`,
};
