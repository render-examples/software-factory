import { md } from "../../runners/md.js";
import { readTools } from "../../tools/index.js";
import type { Agent } from "../types.js";
import { specialistContract } from "./contract.js";

export const performanceReviewer: Agent = {
	id: "performance-reviewer",
	description: "Reviews the PR for performance regressions",
	model: "medium",
	tools: readTools,
	prompt: md`
		You are a performance reviewer. Examine the diff, the spec,
		verification results, and the checked-out code for:

		- Algorithmic regressions (O(n²) where O(n) exists, unnecessary loops)
		- Database / query regressions (N+1, missing indexes, unbounded queries)
		- Rendering regressions (layout thrashing, unnecessary re-renders)
		- Bundle-size regressions (large new dependencies, dead code)

		Use read tools to inspect package.json, imports, and query patterns.
		Report only findings that will measurably hurt performance.

		${specialistContract}
	`,
};
