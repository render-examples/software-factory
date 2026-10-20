import { describe, expect, it } from "vitest";
import { Review, Spec, SpecDraft, TriageDecision, validateSpec } from "../app/contracts/index.js";

const spec = (overrides: Partial<Spec> = {}): Spec => ({
	title: "Add a dark mode toggle",
	summary: "Let users switch the site to a dark theme.",
	problem: "The site is bright at night.",
	goals: ["A toggle in the header"],
	nonGoals: [],
	acceptanceCriteria: [
		{ id: "AC-1", text: "Clicking the toggle switches the theme", verification: "automated" },
		{ id: "AC-2", text: "The choice survives a reload", verification: "manual" },
	],
	approach: "Add a ThemeToggle component.",
	affectedAreas: [
		{ path: "src/App.tsx", change: "render the toggle" },
		{ path: "src/components/ThemeToggle.tsx", change: "new file" },
	],
	testPlan: "Unit test the toggle.",
	risks: [],
	assumptions: [],
	openQuestions: [],
	...overrides,
});

const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
	result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];

describe("TriageDecision", () => {
	const base = { rationale: "r", findings: "f", relevantPaths: [] };

	it("requires questions exactly when asking", () => {
		expect(TriageDecision.safeParse({ ...base, decision: "ask", questions: ["Which page?"] }).success).toBe(true);
		expect(issues(TriageDecision.safeParse({ ...base, decision: "ask", questions: [] }))).toEqual([
			'questions: decision "ask" needs at least one question',
		]);
		expect(issues(TriageDecision.safeParse({ ...base, decision: "draft", questions: ["Why?"] }))).toEqual([
			'questions: decision "draft" takes no questions',
		]);
		expect(TriageDecision.safeParse({ ...base, decision: "decline", questions: [] }).success).toBe(true);
	});
});

describe("Spec", () => {
	it("accepts a full spec and a draft with or without a change summary", () => {
		expect(Spec.parse(spec())).toEqual(spec());
		const notes = { findings: "", relevantPaths: [] };
		expect(SpecDraft.safeParse({ spec: spec(), notes }).success).toBe(true);
		expect(SpecDraft.safeParse({ spec: spec(), notes, changeSummary: "Narrowed AC-2." }).success).toBe(true);
	});

	it("rejects duplicate acceptance criteria", () => {
		const duplicate = spec({
			acceptanceCriteria: [
				{ id: "AC-1", text: "One", verification: "automated" },
				{ id: "AC-1", text: "Two", verification: "manual" },
			],
		});
		expect(validateSpec(duplicate).errors).toEqual(["Duplicate acceptance criterion IDs: AC-1"]);
	});

	it("rejects paths outside the repository and warns about proposed files", () => {
		const result = validateSpec(
			spec({
				affectedAreas: [
					{ path: "../secret", change: "read it" },
					{ path: "src/new.ts", change: "new file" },
				],
			}),
			new Set(["src/App.tsx"]),
		);
		expect(result.errors).toContain("../secret is not a repository-relative path");
		expect(result.warnings).toContain("src/new.ts does not exist yet");
	});

	it("rejects a spec too large for its GitHub marker", () => {
		const result = validateSpec(spec({ approach: "x".repeat(20_000), testPlan: "x".repeat(4_000) }));
		expect(result.errors).toEqual([expect.stringContaining("characters as JSON")]);
	});
});

describe("review contracts", () => {
	it("has no approval field and caps inline comments at 50", () => {
		const comment = { file: "a.ts", line: 3, severity: "low", title: "t", body: "b" };
		expect(Review.safeParse({ summary: "s", riskTier: "low", comments: [comment] }).success).toBe(true);
		expect(Review.safeParse({ summary: "s", riskTier: "low", comments: Array(51).fill(comment) }).success).toBe(false);
		expect(Object.keys(Review.shape)).toEqual(["summary", "riskTier", "comments"]);
	});
});
