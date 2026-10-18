import { describe, expect, it } from "vitest";
import * as contracts from "../app/contracts/index.js";
import {
	Finding,
	Implementation,
	Review,
	SelfReview,
	SPEC_MAX_JSON_CHARS,
	Spec,
	SpecDraft,
	SpecialistReport,
	TriageDecision,
	validateSpec,
} from "../app/contracts/index.js";

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
		expect(issues(TriageDecision.safeParse({ ...base, decision: "ask", questions: [] }))).toEqual(['questions: decision "ask" needs at least one question']);
		expect(issues(TriageDecision.safeParse({ ...base, decision: "draft", questions: ["Why?"] }))).toEqual(['questions: decision "draft" takes no questions']);
		expect(TriageDecision.safeParse({ ...base, decision: "decline", questions: [] }).success).toBe(true);
	});

	it("rejects unknown decisions and more than five questions", () => {
		expect(TriageDecision.safeParse({ ...base, decision: "approve", questions: [] }).success).toBe(false);
		expect(TriageDecision.safeParse({ ...base, decision: "ask", questions: ["1", "2", "3", "4", "5", "6"] }).success).toBe(false);
	});
});

describe("Spec", () => {
	it("accepts a full spec and a draft with or without a change summary", () => {
		expect(Spec.parse(spec())).toEqual(spec());
		const notes = { findings: "", relevantPaths: [] };
		expect(SpecDraft.safeParse({ spec: spec(), notes }).success).toBe(true);
		expect(SpecDraft.safeParse({ spec: spec(), notes, changeSummary: "Narrowed AC-2." }).success).toBe(true);
	});

	it("has no UX verification kind and needs at least one well-formed criterion", () => {
		const ux = spec({ acceptanceCriteria: [{ id: "AC-1", text: "Looks right", verification: "ux" as "manual" }] });
		expect(Spec.safeParse(ux).success).toBe(false);
		expect(Spec.safeParse(spec({ acceptanceCriteria: [] })).success).toBe(false);
		expect(Spec.safeParse(spec({ acceptanceCriteria: [{ id: "1", text: "t", verification: "automated" }] })).success).toBe(false);
		expect(Spec.safeParse(spec({ acceptanceCriteria: [{ id: "AC-0", text: "t", verification: "automated" }] })).success).toBe(false);
	});

	it("bounds field sizes", () => {
		expect(Spec.safeParse(spec({ title: "x".repeat(201) })).success).toBe(false);
		expect(Spec.safeParse(spec({ goals: Array.from({ length: 21 }, (_, i) => `goal ${i}`) })).success).toBe(false);
	});
});

describe("validateSpec", () => {
	it("passes a clean spec with no errors or warnings", () => {
		expect(validateSpec(spec(), new Set(["src/App.tsx", "src/components/ThemeToggle.tsx"]))).toEqual({ errors: [], warnings: [] });
	});

	it("errors on duplicate criterion IDs", () => {
		const dup = spec({
			acceptanceCriteria: [
				{ id: "AC-1", text: "a", verification: "automated" },
				{ id: "AC-1", text: "b", verification: "automated" },
				{ id: "AC-1", text: "c", verification: "automated" },
			],
		});
		expect(validateSpec(dup).errors).toEqual(["Duplicate acceptance criterion IDs: AC-1"]);
	});

	it("errors on paths outside the repository and warns on paths that don't exist yet", () => {
		const result = validateSpec(
			spec({
				affectedAreas: [
					{ path: "/etc/passwd", change: "x" },
					{ path: "src/../../secrets", change: "x" },
					{ path: "C:\\repo\\a.ts", change: "x" },
					{ path: "./src/App.tsx", change: "x" },
					{ path: "src/new.ts", change: "new file" },
				],
			}),
			new Set(["src/App.tsx"]),
		);
		expect(result.errors).toEqual([
			"/etc/passwd is not a repository-relative path",
			"src/../../secrets is not a repository-relative path",
			"C:\\repo\\a.ts is not a repository-relative path",
		]);
		expect(result.warnings).toEqual(["src/new.ts does not exist yet"]);
	});

	it("skips the existence check without a path set, and warns on duplicate paths", () => {
		const result = validateSpec(spec({ affectedAreas: [{ path: "src/a.ts", change: "x" }, { path: "./src/a.ts", change: "y" }] }));
		expect(result).toEqual({ errors: [], warnings: ["Affected areas list a path more than once: src/a.ts"] });
	});

	it("errors when the spec won't fit in its comment marker", () => {
		const big = spec({ risks: Array.from({ length: 20 }, () => "r".repeat(1000)), assumptions: Array.from({ length: 5 }, () => "a".repeat(1000)) });
		expect(JSON.stringify(big).length).toBeGreaterThan(SPEC_MAX_JSON_CHARS);
		expect(validateSpec(big).errors).toEqual([expect.stringMatching(/^The spec is \d+ characters as JSON; the limit is 20000$/)]);
	});

	it("warns on no goals, no automated criterion, and open questions", () => {
		const result = validateSpec(
			spec({ goals: [], acceptanceCriteria: [{ id: "AC-1", text: "Looks right", verification: "manual" }], openQuestions: ["Which color?"] }),
		);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([
			"The spec lists no goals",
			"No acceptance criterion is automated, so verification can't check any of them",
			"The spec has 1 open question(s); answer them before approving",
		]);
	});
});

describe("Implementation and SelfReview", () => {
	it("records the implementer's own verify runs", () => {
		const ok = { summary: "Done.", filesChanged: ["a.ts"], verification: [{ command: "npm test", passed: false, notes: "1 failure" }], followUps: [] };
		expect(Implementation.parse(ok)).toEqual(ok);
		expect(Implementation.safeParse({ ...ok, summary: "" }).success).toBe(false);
		expect(Implementation.safeParse({ ...ok, verification: [{ command: "npm test", passed: "yes", notes: "" }] }).success).toBe(false);
	});

	it("needs an issue to ask for a revision", () => {
		expect(SelfReview.safeParse({ needsRevision: false, issues: [], notes: [] }).success).toBe(true);
		expect(issues(SelfReview.safeParse({ needsRevision: true, issues: [], notes: [] }))).toEqual(["issues: needsRevision needs at least one issue"]);
		expect(SelfReview.safeParse({ needsRevision: true, issues: [{ file: "a.ts", line: 3, problem: "console.log left in" }], notes: [] }).success).toBe(true);
		expect(SelfReview.safeParse({ needsRevision: true, issues: [{ file: "a.ts", line: 0, problem: "p" }], notes: [] }).success).toBe(false);
	});
});

describe("review contracts", () => {
	const finding = { file: "a.ts", line: 3, severity: "medium", confidence: 50, title: "t", body: "b", evidence: "e" };

	it("accepts findings at or above the confidence floor only", () => {
		expect(Finding.safeParse(finding).success).toBe(true);
		expect(Finding.safeParse({ ...finding, confidence: 49 }).success).toBe(false);
		expect(Finding.safeParse({ ...finding, confidence: 101 }).success).toBe(false);
		expect(Finding.safeParse({ ...finding, line: 0 }).success).toBe(false);
		expect(Finding.safeParse({ ...finding, severity: "info" }).success).toBe(false);
		expect(SpecialistReport.safeParse({ findings: [], summary: "" }).success).toBe(true);
	});

	it("has no approval field and caps inline comments at 50", () => {
		const comment = { file: "a.ts", line: 3, severity: "low", title: "t", body: "b", sources: ["tests"] };
		expect(Review.safeParse({ summary: "s", riskTier: "low", comments: [comment] }).success).toBe(true);
		expect(Review.safeParse({ summary: "s", riskTier: "low", comments: Array(51).fill(comment) }).success).toBe(false);
		expect(Review.safeParse({ summary: "s", riskTier: "low", comments: [{ ...comment, sources: [] }] }).success).toBe(false);
		expect(Object.keys(Review.shape)).toEqual(["summary", "riskTier", "comments"]);
	});
});

describe("contracts barrel", () => {
	it("exports the agent contracts and the task inputs", () => {
		for (const name of ["TriageDecision", "Spec", "SpecDraft", "Implementation", "SelfReview", "SpecialistReport", "Review", "validateSpec"]) {
			expect(contracts).toHaveProperty(name);
		}
		for (const name of ["TriageInput", "SpecToPrInput", "PrReviewInput", "CancelInput", "RefreshSnapshotInput"]) expect(contracts).toHaveProperty(name);
	});
});
