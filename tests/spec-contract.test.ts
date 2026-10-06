import { describe, expect, it } from "vitest";
import { type Spec, specSchema, validateSpec } from "../app/contracts/index.js";

const base: Spec = {
	title: "Add filtering",
	summary: "Let users filter todos by status.",
	problem: "The list grows without a way to narrow it.",
	goals: ["Filter by done and not done"],
	nonGoals: [],
	acceptanceCriteria: [
		{ id: "AC-1", text: "A filter control is visible", verification: "ux" },
	],
	approach: "Add a select above the list.",
	affectedAreas: [{ path: "src/App.tsx", change: "Add the control" }],
	testPlan: "Unit test the filter function.",
	risks: [],
	assumptions: [],
	openQuestions: [],
};

describe("spec contract", () => {
	it("requires at least one acceptance criterion", () => {
		expect(
			specSchema.safeParse({ ...base, acceptanceCriteria: [] }).success,
		).toBe(false);
	});

	it("rejects duplicate acceptance criterion IDs", () => {
		const spec: Spec = {
			...base,
			acceptanceCriteria: [
				base.acceptanceCriteria[0],
				{ ...base.acceptanceCriteria[0], text: "Another" },
			],
		};
		expect(validateSpec(spec).errors).toEqual([
			"Duplicate acceptance criterion IDs: AC-1",
		]);
	});

	it("warns, but does not fail, on paths that do not exist yet", () => {
		const result = validateSpec(base, new Set(["src/main.tsx"]));
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual(["src/App.tsx does not exist yet"]);
	});
});
