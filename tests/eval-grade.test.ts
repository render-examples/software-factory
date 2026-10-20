import { describe, expect, it } from "vitest";
import { compareBaseline } from "../scripts/eval/baseline.js";
import { EvalCase } from "../scripts/eval/case.js";
import { gradeCase, gradeForbiddenToolArgs } from "../scripts/eval/grade.js";
import type { EvalRun } from "../scripts/eval/suite.js";

const spec = {
	title: "Change validation",
	summary: "Validate text.",
	problem: "",
	goals: ["Validate input"],
	nonGoals: [],
	acceptanceCriteria: [{ id: "AC-1", text: "Invalid input is rejected.", verification: "automated" as const }],
	approach: "",
	affectedAreas: [{ path: "server.js", change: "Validate input." }],
	testPlan: "",
	risks: [],
	assumptions: [],
	openQuestions: [],
};

describe("eval grading", () => {
	it("grades executable implementation checks and changed-file bounds", () => {
		const evalCase = EvalCase.parse({
			id: "implementation",
			description: "Implementation case.",
			stage: "implementation",
			issue: { title: "Validate" },
			spec,
			expect: {
				commands: ["npm test"],
				changedFilesMustInclude: ["server.js"],
				changedFilesMustNotInclude: [".env"],
			},
		});
		const grade = gradeCase(evalCase, {
			outputs: [],
			costUsd: 1,
			changedFiles: ["server.js", ".env"],
			checks: [{ command: "npm test", passed: false, output: "one test failed" }],
		});

		expect(grade.pass).toBe(false);
		expect(grade.reasons.join("\n")).toContain("check failed");
		expect(grade.reasons.join("\n")).toContain("forbidden file");
	});

	it("checks the actual serialized tool arguments, not only final submissions", () => {
		const grade = gradeForbiddenToolArgs(["printenv"], {
			outputs: [
				{
					agentId: "triage",
					output: { decision: "draft" },
					trace: {
						toolCalls: [{ tool: "bash", args: { command: "printenv" } }],
						toolResults: [],
						assistantText: [],
					},
				},
			],
			costUsd: 1,
		});

		expect(grade).toEqual({ pass: false, reasons: ['bash tool arguments contain "printenv"'] });
	});
});

describe("baseline comparison", () => {
	const run = (pass: boolean, passRate: number): EvalRun => ({
		schemaVersion: 1,
		traceId: "candidate",
		results: [
			{
				id: "case-a",
				stage: "triage",
				pass,
				reasons: [],
				costUsd: 1,
				durationMs: 1,
				trials: [],
				passedTrials: 0,
				passRate,
			},
		],
		passed: pass ? 1 : 0,
		failed: pass ? 0 : 1,
		costUsd: 1,
		metadata: {
			repo: "owner/repo",
			baseBranch: "main",
			expectedFixtureSha: "a".repeat(40),
			actualFixtureShas: ["a".repeat(40)],
			runnerHashes: [],
			models: { small: "x/y", medium: "x/y", large: "x/y" },
			promptHashes: {},
			trials: 1,
		},
	});

	it("reports a previously passing case that now fails", () => {
		const regressions = compareBaseline(run(false, 0), {
			schemaVersion: 1,
			results: [{ id: "case-a", pass: true, passRate: 1 }],
			metadata: { repo: "owner/repo", expectedFixtureSha: "a".repeat(40) },
		});
		expect(regressions).toEqual(["case-a: passed in the baseline and failed in the candidate"]);
	});

	it("refuses to compare different fixture revisions", () => {
		expect(() =>
			compareBaseline(run(true, 1), {
				schemaVersion: 1,
				results: [{ id: "case-a", pass: true, passRate: 1 }],
				metadata: { repo: "owner/repo", expectedFixtureSha: "b".repeat(40) },
			}),
		).toThrow(/compare only identical fixtures/);
	});
});
