import { describe, expect, it } from "vitest";
import {
	STATUS,
	clearStatusLabels,
	isStatusLabel,
	isTriggerLabel,
} from "../app/workflows/spec-to-pr/labels.js";

describe("status labels use factory-status: prefix", () => {
	it("every status label starts with factory-status:", () => {
		for (const label of Object.values(STATUS)) {
			expect(label).toMatch(/^factory-status:/);
		}
	});

	it("isStatusLabel matches the new prefix", () => {
		expect(isStatusLabel("factory-status:analyzing")).toBe(true);
		expect(isStatusLabel("factory-status:failed")).toBe(true);
	});

	it("isStatusLabel does not match trigger labels", () => {
		expect(isStatusLabel("factory:triage")).toBe(false);
		expect(isStatusLabel("factory:full-run")).toBe(false);
		expect(isStatusLabel("factory:spec-approved")).toBe(false);
		expect(isStatusLabel("factory:pr-review")).toBe(false);
	});
});

describe("isTriggerLabel", () => {
	it("recognizes configured trigger labels", () => {
		expect(isTriggerLabel("factory:triage")).toBe(true);
		expect(isTriggerLabel("factory:full-run")).toBe(true);
		expect(isTriggerLabel("factory:spec-approved")).toBe(true);
		expect(isTriggerLabel("factory:pr-review")).toBe(true);
	});

	it("rejects status labels", () => {
		expect(isTriggerLabel("factory-status:analyzing")).toBe(false);
	});

	it("rejects arbitrary labels", () => {
		expect(isTriggerLabel("bug")).toBe(false);
	});
});

describe("clearStatusLabels never removes trigger labels", () => {
	it("removes status labels but skips trigger labels", async () => {
		const removed: string[] = [];
		const fakeGh = {
			removeLabel: async (_repo: unknown, _issue: number, label: string) => {
				removed.push(label);
			},
		};

		const labels = [
			"factory:triage",
			"factory:full-run",
			"factory-status:analyzing",
			"factory-status:implementing",
			"bug",
		];

		await clearStatusLabels(
			fakeGh as never,
			{ owner: "o", repo: "r" },
			1,
			labels,
		);

		expect(removed).toContain("factory-status:analyzing");
		expect(removed).toContain("factory-status:implementing");
		expect(removed).not.toContain("factory:triage");
		expect(removed).not.toContain("factory:full-run");
		expect(removed).not.toContain("bug");
	});
});
