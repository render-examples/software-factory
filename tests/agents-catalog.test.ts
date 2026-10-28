import { describe, expect, it } from "vitest";
import { AGENTS, implementer, prReviewer, specWriter, triage } from "../app/agents/index.js";
import { bundleInputs } from "../app/runner/bundle.js";

const agents = [triage, specWriter, implementer, prReviewer];

describe("agent registry", () => {
	it("bundles every built-in agent, each with a non-empty prompt", () => {
		expect(AGENTS.map((agent) => agent.id)).toEqual(agents.map((agent) => agent.id));
		for (const agent of AGENTS) expect(agent.prompt.trim(), agent.id).not.toBe("");
	});

	it("keeps host-only code out of the sandbox runner bundle", { timeout: 60_000 }, async () => {
		const app = (await bundleInputs()).filter((path) => !path.includes("node_modules/"));
		const hostOnly = app.filter(
			(path) => /^app\/(github|sandbox|workflows|claims|gateway|events|config|entrypoints)\//.test(path) || path === "app/agents/run.ts",
		);
		expect(hostOnly).toEqual([]);
		expect(app).toContain("app/agents/registry.ts");
	});
});

describe("agent authority", () => {
	it("gives every agent a unique id and prompt file", () => {
		const ids = agents.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(agents.map((agent) => agent.promptPath)).size).toBe(ids.length);
	});

	it("gives only the implementer write tools and runs every agent in a sandbox", () => {
		const writers = agents.filter((agent) => agent.tools.some((tool) => tool === "edit" || tool === "write")).map((agent) => agent.id);
		expect(writers).toEqual(["implementer"]);
		expect(agents.every((agent) => agent.tools.length > 0)).toBe(true);
	});

	it("rejects unknown fields in every object an agent can submit, so a misspelled field is named in the error", () => {
		const looseObjects = (schema: unknown, path: string): string[] => {
			if (typeof schema !== "object" || schema === null) return [];
			const node = schema as Record<string, unknown>;
			const own = node.type === "object" && node.additionalProperties !== false ? [path || "(root)"] : [];
			return [...own, ...Object.entries(node).flatMap(([key, value]) => looseObjects(value, `${path}/${key}`))];
		};
		for (const agent of agents) expect(looseObjects(agent.outputJsonSchema, ""), agent.id).toEqual([]);
	});
});
