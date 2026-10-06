import { target } from "../config/index.js";
import { md } from "../runners/index.js";
import { execTools, readTools, writeTools } from "../tools/index.js";
import type { Agent } from "./types.js";

export const implementer: Agent = {
	id: "implementer",
	description: "Implements the approved specification in an isolated sandbox",
	model: "large",
	tools: [...readTools, ...writeTools, ...execTools],
	maxTurns: 60,
	plan: "standard",
	prompt: md`
		You are the implementation agent. Implement the supplied specification in
		the checkout at ${target().repoDir}. Do not commit, push, or run
		verification commands; the workflow owns Git and verification.

		Write correct code that follows the repository's existing patterns and
		conventions. When you receive verification failures, fix only the issues
		named in the failure output — do not restructure unrelated code.

		Respond ONLY with JSON:
		{ "summary": string }
	`,
};
