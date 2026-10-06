import { describe, expect, it } from "vitest";
import {
	specialistOutputSchema,
	synthesisSchema,
	triageDecisionSchema,
} from "../app/contracts/index.js";
import { parseModelJson } from "../app/runners/index.js";

const decision = {
	decision: "draft",
	questions: [],
	rationale: "Clear enough",
	findings: "The list lives in src/App.tsx",
	relevantPaths: ["src/App.tsx"],
};

describe("parseModelJson", () => {
	it("parses a bare JSON object", () => {
		expect(
			parseModelJson(triageDecisionSchema, JSON.stringify(decision)),
		).toEqual(decision);
	});

	it("parses JSON inside a fenced code block", () => {
		const raw = `Here you go:\n\`\`\`json\n${JSON.stringify({ ...decision, decision: "ask", questions: ["what?"] })}\n\`\`\``;
		expect(parseModelJson(triageDecisionSchema, raw)?.questions).toEqual([
			"what?",
		]);
	});

	it("parses JSON surrounded by prose", () => {
		const raw = `Sure. ${JSON.stringify(decision)} Hope that helps.`;
		expect(parseModelJson(triageDecisionSchema, raw)?.decision).toBe("draft");
	});

	it("returns null rather than throwing on unparseable output", () => {
		expect(
			parseModelJson(triageDecisionSchema, "I could not decide."),
		).toBeNull();
	});

	it("returns null when JSON is valid but violates the schema", () => {
		expect(
			parseModelJson(
				triageDecisionSchema,
				JSON.stringify({ ...decision, decision: "maybe" }),
			),
		).toBeNull();
	});
});

describe("schemas", () => {
	const finding = {
		path: "a.ts",
		line: 3,
		severity: "high",
		title: "t",
		body: "b",
		evidence: "e",
	};

	it("bounds specialist confidence to 0-100", () => {
		expect(
			specialistOutputSchema.safeParse({
				findings: [{ ...finding, confidence: 101 }],
			}).success,
		).toBe(false);
		expect(
			specialistOutputSchema.safeParse({
				findings: [{ ...finding, confidence: 80 }],
			}).success,
		).toBe(true);
	});

	it("gives the synthesizer no way to approve or request changes", () => {
		const synthesis = { summary: "s", riskTier: "low", comments: [] };
		expect(synthesisSchema.safeParse(synthesis).success).toBe(true);
		expect(
			Object.keys(synthesisSchema.parse({ ...synthesis, decision: "approve" })),
		).not.toContain("decision");
	});
});
