import { describe, expect, it } from "vitest";
import { implementationReviewer, implementer, prReviewer, specWriter, triage } from "../app/agents/index.js";

const agents = [triage, specWriter, implementer, implementationReviewer, prReviewer];

describe("agent authority", () => {
	it("gives every agent a unique id and prompt file", () => {
		const ids = agents.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(agents.map((agent) => agent.promptPath)).size).toBe(ids.length);
	});

	it("gives only the implementer write tools and runs every agent in a sandbox", () => {
		const writers = agents.filter((agent) => agent.tools.some((tool) => tool === "edit" || tool === "write")).map((agent) => agent.id);
		expect(writers).toEqual(["implementer"]);
		expect(agents.every((agent) => agent.tools.length > 0)).toBe(true);
	});
});
