import { describe, expect, it } from "vitest";
import {
	correctnessReviewer,
	implementer,
	performanceReviewer,
	securityReviewer,
	selfReview,
	specWriter,
	synthesizer,
	testsReviewer,
	triage,
} from "../app/agents/index.js";

const agents = [
	triage,
	specWriter,
	implementer,
	selfReview,
	securityReviewer,
	correctnessReviewer,
	performanceReviewer,
	testsReviewer,
	synthesizer,
];

describe("agent authority", () => {
	it("gives every agent a unique id and prompt file", () => {
		const ids = agents.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(agents.map((agent) => agent.promptPath)).size).toBe(ids.length);
	});

	it("gives only the implementer write tools; only the synthesizer runs without a sandbox", () => {
		const writers = agents.filter((agent) => agent.tools.some((tool) => tool === "edit" || tool === "write")).map((agent) => agent.id);
		expect(writers).toEqual(["implementer"]);
		expect(agents.filter((agent) => agent.tools.length === 0).map((agent) => agent.id)).toEqual(["synthesizer"]);
	});
});
