import { describe, expect, it } from "vitest";
import {
	specialistFindingSchema,
	specialistOutputSchema,
	synthesisSchema,
} from "../app/contracts/review.js";
import { uxTestOutputSchema } from "../app/contracts/ux.js";

describe("specialistFindingSchema", () => {
	it("accepts a valid finding", () => {
		const result = specialistFindingSchema.safeParse({
			path: "src/index.ts",
			line: 42,
			severity: "high",
			confidence: 85,
			title: "Issue found",
			body: "Details here",
			evidence: "code snippet",
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing path", () => {
		const result = specialistFindingSchema.safeParse({
			line: 42,
			severity: "high",
			confidence: 85,
			title: "Issue",
			body: "Details",
			evidence: "code",
		});
		expect(result.success).toBe(false);
	});

	it("rejects confidence out of range", () => {
		const result = specialistFindingSchema.safeParse({
			path: "f.ts",
			line: 1,
			severity: "low",
			confidence: 150,
			title: "x",
			body: "y",
			evidence: "z",
		});
		expect(result.success).toBe(false);
	});
});

describe("specialistOutputSchema", () => {
	it("accepts empty findings", () => {
		const result = specialistOutputSchema.safeParse({ findings: [] });
		expect(result.success).toBe(true);
	});
});

describe("synthesisSchema", () => {
	it("accepts a valid synthesis", () => {
		const result = synthesisSchema.safeParse({
			summary: "Overview",
			riskTier: "low",
			comments: [{ path: "f.ts", line: 10, body: "Fix this" }],
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid risk tier", () => {
		const result = synthesisSchema.safeParse({
			summary: "x",
			riskTier: "extreme",
			comments: [],
		});
		expect(result.success).toBe(false);
	});
});

describe("uxTestOutputSchema", () => {
	it("accepts valid UX results", () => {
		const result = uxTestOutputSchema.safeParse({
			results: [
				{
					criterionId: "AC-1",
					verdict: "pass",
					observations: "Looks good",
					screenshotArtifactIds: ["art-123"],
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("accepts inconclusive verdict", () => {
		const result = uxTestOutputSchema.safeParse({
			results: [
				{
					verdict: "inconclusive",
					observations: "Could not reach",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid verdict", () => {
		const result = uxTestOutputSchema.safeParse({
			results: [
				{
					verdict: "maybe",
					observations: "Not sure",
				},
			],
		});
		expect(result.success).toBe(false);
	});
});
