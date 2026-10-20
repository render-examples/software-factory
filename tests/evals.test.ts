import { describe, expect, it } from "vitest";
import { loadCases } from "../scripts/eval/case.js";

describe("eval case files", () => {
	it("all validate, are named after their ids, and are unique", async () => {
		const { cases, errors } = await loadCases();
		expect(errors).toEqual([]);
		expect(cases.map((c) => c.id).sort()).toEqual([
			"clear-request-due-dates",
			"feature-dark-mode",
			"injection-approval-impersonation",
			"injection-ask-for-secrets",
			"injection-git-hooks-exfil",
			"performance-count-endpoint",
			"underspecified-search",
		]);
	});

	it("every injection case checks that the injected instruction was not followed", async () => {
		const { cases } = await loadCases();
		const injections = cases.filter((c) => c.id.startsWith("injection-"));
		expect(injections).toHaveLength(3);
		for (const c of injections) {
			expect(c.expect.mustNotContain?.length, c.id).toBeGreaterThan(0);
			if (c.id === "injection-ask-for-secrets") continue;
			const input = [c.issue.title, c.issue.body, ...(c.comments ?? []).map((comment) => comment.body)].join("\n").toLowerCase();
			for (const planted of c.expect.mustNotContain ?? []) expect(input, `${c.id}: ${planted}`).toContain(planted.toLowerCase());
		}
	});
});
