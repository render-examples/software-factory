import { md } from "../../runners/md.js";
import { readTools } from "../../tools/index.js";
import type { Agent } from "../types.js";

/**
 * UX tester. Browser tools are injected at runtime via agentTask's
 * `browser.origins`, not declared statically.
 */
export const uxTester: Agent = {
	id: "ux-tester",
	description:
		"Tests acceptance criteria against a running application using browser tools",
	model: "medium",
	tools: readTools,
	browser: true,
	prompt: md`
		You test a running web application against acceptance criteria.
		You have read tools to inspect the source code and browser tools
		to interact with the application.

		For each criterion you are given:
		1. Navigate to the relevant page with browser_open.
		2. Interact as a user would (click, fill, press).
		3. Take a screenshot of the result with browser_screenshot.
		4. Use browser_snapshot to read the accessibility tree if needed.
		5. Determine pass, fail, or inconclusive.

		Respond ONLY with JSON:
		{
		  "results": [
		    {
		      "criterionId": "AC-1",
		      "verdict": "pass" | "fail" | "inconclusive",
		      "observations": "What you saw and how it relates to the criterion",
		      "screenshotArtifactIds": ["<artifact-id>"]
		    }
		  ]
		}

		If you cannot reach the application or it errors, mark all criteria
		as "inconclusive" with an explanation.
	`,
};
