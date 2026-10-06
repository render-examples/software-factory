import { describe, expect, it } from "vitest";
import { reviewBody } from "../app/format/review-body.js";
import type { PreviewStatus } from "../app/preview/types.js";

describe("reviewBody", () => {
	const baseInput = {
		runId: "run-123",
		riskTier: "low",
		summary: "Everything looks good",
		verificationResults: [
			{ command: "npm test", exitCode: 0, durationMs: 5000, outputTail: "ok" },
			{
				command: "npm run build",
				exitCode: 1,
				durationMs: 3000,
				outputTail: "error",
			},
		],
		specialistFindings: new Map([
			[
				"security",
				[
					{
						path: "src/auth.ts",
						line: 42,
						severity: "high" as const,
						confidence: 85,
						title: "SQL injection risk",
						body: "User input not sanitized",
						evidence: "query(input)",
					},
				],
			],
			["correctness", []],
		]),
		uxResults: [],
		previewStatus: { state: "not_configured" } as PreviewStatus,
	};

	it("includes the run marker", () => {
		const body = reviewBody(baseInput);
		expect(body).toContain("<!-- render-factory:review run=run-123 -->");
	});

	it("includes a verification table", () => {
		const body = reviewBody(baseInput);
		expect(body).toContain("### Verification");
		expect(body).toContain("npm test");
		expect(body).toContain("✅");
		expect(body).toContain("❌");
	});

	it("groups findings by specialist", () => {
		const body = reviewBody(baseInput);
		expect(body).toContain("### Security");
		expect(body).toContain("SQL injection risk");
		expect(body).toContain("### Correctness");
		expect(body).toContain("No findings");
	});

	it("shows risk tier", () => {
		const body = reviewBody(baseInput);
		expect(body).toContain("**Risk tier:** low");
	});

	it("shows preview status", () => {
		const body = reviewBody({
			...baseInput,
			previewStatus: { state: "live", url: "https://preview.example.com" },
		});
		expect(body).toContain("Live at https://preview.example.com");
	});

	it("shows local dev skipped reason", () => {
		const body = reviewBody({
			...baseInput,
			localDevSkipped: "Server crashed",
		});
		expect(body).toContain("Skipped: Server crashed");
	});

	it("shows UX results when present", () => {
		const body = reviewBody({
			...baseInput,
			uxResults: [
				{
					criterionId: "AC-1",
					verdict: "pass",
					observations: "Page loaded correctly",
					screenshotArtifactIds: [],
				},
			],
		});
		expect(body).toContain("### UX testing");
		expect(body).toContain("AC-1");
		expect(body).toContain("pass");
	});

	it("redacts secrets", () => {
		const body = reviewBody({
			...baseInput,
			summary: "Found ghp_abcdefghijklmnopqrstuvwxyz12345678 in code",
		});
		expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz12345678");
		expect(body).toContain("[REDACTED]");
	});
});
