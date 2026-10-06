/**
 * Tool access is the security boundary between an agent and the machine.
 * These assertions are what stop a review agent from gaining write access.
 */
import { describe, expect, it } from "vitest";
import * as agents from "../app/agents/index.js";
import type { Agent } from "../app/agents/index.js";

const all: Agent[] = [
	agents.triage,
	agents.specWriter,
	agents.implementer,
	agents.selfReview,
];

const toolNames = (agent: Agent) =>
	(agent.tools ?? []).map((tool) => tool.name);

describe("agent definitions", () => {
	it("registers agents with unique ids", () => {
		expect(new Set(all.map((agent) => agent.id)).size).toBe(all.length);
	});

	it("gives every agent a prompt and a known model tier", () => {
		for (const agent of all) {
			expect(agent.prompt.length).toBeGreaterThan(0);
			expect(["small", "medium", "large"]).toContain(agent.model);
		}
	});
});

describe("tool access", () => {
	it("gives triage and spec-writer read tools", () => {
		for (const agent of [agents.triage, agents.specWriter]) {
			expect(toolNames(agent).sort()).toEqual([
				"sandbox__list_dir",
				"sandbox__read_file",
				"sandbox__search",
			]);
		}
	});

	it("gives the implementer read + write + exec tools", () => {
		expect(toolNames(agents.implementer).sort()).toEqual([
			"sandbox__apply_patch",
			"sandbox__exec",
			"sandbox__list_dir",
			"sandbox__read_file",
			"sandbox__search",
			"sandbox__write_file",
		]);
	});

	it("gives no other agent write or exec tools", () => {
		for (const agent of all.filter((a) => a.id !== "implementer")) {
			expect(toolNames(agent)).not.toContain("sandbox__exec");
			expect(toolNames(agent)).not.toContain("sandbox__write_file");
			expect(toolNames(agent)).not.toContain("sandbox__apply_patch");
		}
	});

	it("gives reasoning-only agents no tools", () => {
		for (const id of ["self-review"]) {
			const agent = all.find((candidate) => candidate.id === id);
			expect(toolNames(agent as Agent)).toEqual([]);
		}
	});

	it("never grants a Claude built-in tool", () => {
		const builtIns = ["Bash", "Read", "Write", "Edit", "NotebookEdit"];
		for (const agent of all) {
			for (const name of toolNames(agent)) {
				expect(builtIns).not.toContain(name);
				expect(name.startsWith("sandbox__")).toBe(true);
			}
		}
	});
});

describe("pinned tool-name lists", () => {
	it.each([
		["triage", ["sandbox__list_dir", "sandbox__read_file", "sandbox__search"]],
		[
			"spec-writer",
			["sandbox__list_dir", "sandbox__read_file", "sandbox__search"],
		],
		[
			"implementer",
			[
				"sandbox__apply_patch",
				"sandbox__exec",
				"sandbox__list_dir",
				"sandbox__read_file",
				"sandbox__search",
				"sandbox__write_file",
			],
		],
		["self-review", []],
	])("agent %s has exactly %j", (id, expected) => {
		const agent = all.find((a) => a.id === id);
		expect(agent).toBeDefined();
		expect(toolNames(agent as Agent).sort()).toEqual(expected);
	});
});

describe("runner override", () => {
	it("defaults to no per-agent runner override", () => {
		for (const agent of all) {
			expect(agent.runner).toBeUndefined();
		}
	});
});
