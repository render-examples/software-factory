import { describe, expect, it } from "vitest";
import { parseModelJson } from "../app/claude/index.js";
import {
	judgeSchema,
	reviewerOutputSchema,
	triageSchema,
	workflowInputSchema,
} from "../app/contracts/index.js";

describe("parseModelJson", () => {
	it("parses a bare JSON object", () => {
		expect(
			parseModelJson(triageSchema, '{"hasEnoughDetail":true,"questions":[],"rationale":"ok"}'),
		).toEqual({ hasEnoughDetail: true, questions: [], rationale: "ok" });
	});

	it("parses JSON inside a fenced code block", () => {
		const raw = 'Here you go:\n```json\n{"hasEnoughDetail":false,"questions":["what?"],"rationale":"thin"}\n```';
		expect(parseModelJson(triageSchema, raw)?.questions).toEqual(["what?"]);
	});

	it("parses JSON surrounded by prose", () => {
		const raw = 'Sure. {"hasEnoughDetail":true,"questions":[],"rationale":"fine"} Hope that helps.';
		expect(parseModelJson(triageSchema, raw)?.hasEnoughDetail).toBe(true);
	});

	it("returns null rather than throwing on unparseable output", () => {
		expect(parseModelJson(triageSchema, "I could not decide.")).toBeNull();
	});

	it("returns null when JSON is valid but violates the schema", () => {
		expect(parseModelJson(triageSchema, '{"hasEnoughDetail":"yes"}')).toBeNull();
	});
});

describe("schemas", () => {
	it("requires a positive issue number", () => {
		expect(workflowInputSchema.safeParse({ issueNumber: 0, runId: "r" }).success).toBe(false);
		expect(workflowInputSchema.safeParse({ issueNumber: 7, runId: "r" }).success).toBe(true);
	});

	it("bounds reviewer confidence to 0-100", () => {
		const finding = { severity: "high", file: "a.ts", description: "d" };
		expect(
			reviewerOutputSchema.safeParse({ findings: [{ ...finding, confidence: 101 }] }).success,
		).toBe(false);
		expect(
			reviewerOutputSchema.safeParse({ findings: [{ ...finding, confidence: 80 }] }).success,
		).toBe(true);
	});

	it("rejects a judge decision outside the allowed set", () => {
		expect(judgeSchema.safeParse({ decision: "lgtm", summary: "s" }).success).toBe(false);
		expect(judgeSchema.safeParse({ decision: "approve", summary: "s" }).success).toBe(true);
	});
});
