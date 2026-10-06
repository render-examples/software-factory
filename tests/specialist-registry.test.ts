import { describe, expect, it } from "vitest";
import {
	resolveSpecialists,
	knownSpecialistNames,
} from "../app/agents/reviewers/registry.js";

describe("specialist registry", () => {
	it("resolves all default specialists", () => {
		const agents = resolveSpecialists([
			"security",
			"correctness",
			"performance",
			"tests",
		]);
		expect(agents).toHaveLength(4);
		expect(agents.map((a) => a.id)).toEqual([
			"security-reviewer",
			"correctness-reviewer",
			"performance-reviewer",
			"tests-reviewer",
		]);
	});

	it("throws on unknown specialist name", () => {
		expect(() => resolveSpecialists(["security", "unknown"])).toThrow(
			/Unknown specialist "unknown"/,
		);
	});

	it("resolves a subset", () => {
		const agents = resolveSpecialists(["security"]);
		expect(agents).toHaveLength(1);
		expect(agents[0].id).toBe("security-reviewer");
	});

	it("lists known names", () => {
		const names = knownSpecialistNames();
		expect(names).toContain("security");
		expect(names).toContain("correctness");
		expect(names).toContain("performance");
		expect(names).toContain("tests");
	});
});

describe("specialist agents", () => {
	it("each has read tools", () => {
		const agents = resolveSpecialists([
			"security",
			"correctness",
			"performance",
			"tests",
		]);
		for (const agent of agents) {
			expect(agent.tools).toBeDefined();
			const names = (agent.tools ?? []).map((t) => t.name);
			expect(names).toContain("sandbox__read_file");
			expect(names).toContain("sandbox__list_dir");
			expect(names).toContain("sandbox__search");
			expect(names).not.toContain("sandbox__exec");
			expect(names).not.toContain("sandbox__write_file");
		}
	});

	it("each uses medium tier", () => {
		const agents = resolveSpecialists([
			"security",
			"correctness",
			"performance",
			"tests",
		]);
		for (const agent of agents) {
			expect(agent.model).toBe("medium");
		}
	});
});
