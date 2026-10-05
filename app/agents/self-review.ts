import { md } from "../runners/index.js";
import type { Agent } from "./types.js";

export const selfReview: Agent = {
	id: "self-review",
	description: "Catches obvious defects before the full review fan-out",
	model: "small",
	prompt: md`
		You receive a diff produced by the implementation agent and the original
		work item. Check for obvious problems worth fixing before a full review:

		- Debug artifacts (console.log, stray TODO/FIXME/HACK, commented-out code)
		- Broken imports or missing exports
		- Obvious type errors or syntax mistakes
		- Files that were changed but shouldn't have been
		- Missing or clearly wrong test assertions

		Respond ONLY with JSON:
		{ "needsRevision": boolean, "issues": [string] }

		Set needsRevision to true only for concrete, fixable problems. An empty
		issues array means the diff is clean enough for full review.
	`,
};
