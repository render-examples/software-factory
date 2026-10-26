import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Reporter } from "../scripts/lib/output.js";
import { ENV_GROUPS, SERVICE_ENV } from "../scripts/lib/requirements.js";
import { setupRender } from "../scripts/lib/setup-render.js";

const WORKSPACE = "tea-abc123";
const SECRETS = {
	RENDER_API_KEY: "rnd_renderSECRETkey",
	GITHUB_WEBHOOK_SECRET: "whsec-super-secret-value",
	GITHUB_APP_PRIVATE_KEY: "cHJpdmF0ZS1rZXktU0VDUkVU",
	ANTHROPIC_API_KEY: "sk-ant-SECRET-model-key",
};
const ENV = { ...SECRETS, RENDER_WORKSPACE_ID: WORKSPACE, GITHUB_APP_ID: "1" };

interface StoredGroup {
	id: string;
	name: string;
	ownerId: string;
	envVars: { key: string; value: string }[];
}

interface Call {
	method: string;
	path: string;
	auth: string;
	body: unknown;
}

/** A Render API with an in-memory set of env groups. */
function renderWorld(opts: { groups?: StoredGroup[]; ownerStatus?: number } = {}) {
	const groups = opts.groups ?? [];
	const calls: Call[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const call: Call = {
			method: init?.method ?? "GET",
			path: url.pathname,
			auth: headers.Authorization ?? "",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		calls.push(call);
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		const groupPath = /^\/v1\/env-groups\/([^/]+)(?:\/env-vars\/([^/]+))?$/.exec(url.pathname);
		if (call.method === "GET" && url.pathname === `/v1/owners/${WORKSPACE}`) {
			return opts.ownerStatus ? json({ message: "nope" }, opts.ownerStatus) : json({ id: WORKSPACE, name: "Acme", type: "team" });
		}
		if (call.method === "GET" && url.pathname === "/v1/env-groups") {
			const name = url.searchParams.get("name") ?? "";
			return json(groups.filter((g) => g.name.includes(name)).map(({ envVars: _, ...envGroup }) => ({ cursor: envGroup.id, envGroup })));
		}
		if (call.method === "POST" && url.pathname === "/v1/env-groups") {
			const body = call.body as Omit<StoredGroup, "id">;
			const group = { ...body, id: `evg-${groups.length + 1}` };
			groups.push(group);
			return json(group, 201);
		}
		const group = groupPath && groups.find((g) => g.id === groupPath[1]);
		if (group && call.method === "GET" && !groupPath[2]) return json(group);
		if (group && call.method === "PUT" && groupPath[2]) {
			const key = decodeURIComponent(groupPath[2]);
			const value = (call.body as { value: string }).value;
			group.envVars = [...group.envVars.filter((v) => v.key !== key), { key, value }];
			return json(group);
		}
		return json({ message: "Not Found" }, 404);
	}) as typeof globalThis.fetch;
	return { fetch, calls, groups };
}

async function run(world: ReturnType<typeof renderWorld>, env: Record<string, string | undefined> = ENV) {
	const lines: string[] = [];
	const code = await setupRender({ env, fetch: world.fetch }, new Reporter((line) => lines.push(line)));
	return { code, output: lines.join("\n") };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("setup:render", () => {
	it("creates each group with exactly its keys, and keeps App and model credentials off the gateway", async () => {
		const world = renderWorld();
		const { code, output } = await run(world);
		expect(code).toBe(0);

		const byName = Object.fromEntries(world.groups.map((g) => [g.name, Object.fromEntries(g.envVars.map((v) => [v.key, v.value]))]));
		expect(byName).toEqual({
			"software-factory-shared": { RENDER_API_KEY: SECRETS.RENDER_API_KEY },
			"software-factory-gateway": { GITHUB_WEBHOOK_SECRET: SECRETS.GITHUB_WEBHOOK_SECRET },
			"software-factory-workflows": {
				RENDER_WORKSPACE_ID: WORKSPACE,
				GITHUB_APP_ID: "1",
				GITHUB_APP_PRIVATE_KEY: SECRETS.GITHUB_APP_PRIVATE_KEY,
				ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY,
			},
		});
		expect(world.groups.every((g) => g.ownerId === WORKSPACE)).toBe(true);
		expect(world.calls.every((c) => c.auth === `Bearer ${SECRETS.RENDER_API_KEY}`)).toBe(true);
		for (const secret of Object.values(SECRETS)) expect(output).not.toContain(secret);
	});

	it("writes nothing when a value is missing", async () => {
		const world = renderWorld();
		const { code, output } = await run(world, { ...ENV, ANTHROPIC_API_KEY: "" });
		expect(code).toBe(1);
		expect(output).toContain("ANTHROPIC_API_KEY is not set");
		expect(world.calls).toEqual([]);
	});

	it("updates only changed keys and leaves keys it doesn't manage alone", async () => {
		const world = renderWorld({
			groups: [
				{ id: "evg-a", name: "software-factory-shared", ownerId: WORKSPACE, envVars: [{ key: "RENDER_API_KEY", value: SECRETS.RENDER_API_KEY }] },
				{ id: "evg-b", name: "software-factory-gateway", ownerId: WORKSPACE, envVars: [{ key: "GITHUB_WEBHOOK_SECRET", value: "old" }] },
				{
					id: "evg-c",
					name: "software-factory-workflows",
					ownerId: WORKSPACE,
					envVars: [{ key: "GITHUB_API_URL", value: "https://ghe.example.com/api/v3" }],
				},
			],
		});
		const { code } = await run(world);
		expect(code).toBe(0);
		expect(writes(world.calls).map((c) => `${c.method} ${c.path}`)).toEqual([
			"PUT /v1/env-groups/evg-b/env-vars/GITHUB_WEBHOOK_SECRET",
			"PUT /v1/env-groups/evg-c/env-vars/RENDER_WORKSPACE_ID",
			"PUT /v1/env-groups/evg-c/env-vars/GITHUB_APP_ID",
			"PUT /v1/env-groups/evg-c/env-vars/GITHUB_APP_PRIVATE_KEY",
			"PUT /v1/env-groups/evg-c/env-vars/ANTHROPIC_API_KEY",
		]);
		expect(world.groups.find((g) => g.id === "evg-c")?.envVars).toContainEqual({ key: "GITHUB_API_URL", value: "https://ghe.example.com/api/v3" });

		const again = renderWorld({ groups: world.groups });
		await run(again);
		expect(writes(again.calls)).toEqual([]);
	});

	it("refuses to pick between two groups with the same name", async () => {
		const duplicate = { name: "software-factory-gateway", ownerId: WORKSPACE, envVars: [] };
		const world = renderWorld({ groups: [{ ...duplicate, id: "evg-1" }, { ...duplicate, id: "evg-2" }] });
		const { code, output } = await run(world);
		expect(code).toBe(1);
		expect(output).toContain("2 env groups are named software-factory-gateway");
		expect(world.groups.filter((g) => g.name === "software-factory-gateway")).toHaveLength(2);
		expect(writes(world.calls).filter((c) => /evg-[12]/.test(c.path))).toEqual([]);
	});

	it("stops before any group work when the API key is rejected", async () => {
		const world = renderWorld({ ownerStatus: 401 });
		const { code, output } = await run(world);
		expect(code).toBe(1);
		expect(output).toContain("RENDER_API_KEY was rejected");
		expect(world.calls).toHaveLength(1);
	});
});

describe("render.yaml env groups", () => {
	const blueprint = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");

	/** The `fromGroup` names in one service's block of render.yaml. */
	function linkedGroups(service: string): string[] {
		const start = blueprint.search(new RegExp(`- type: \\w+\\n\\s+name: ${service}\\n`));
		const next = blueprint.indexOf("- type:", start + 1);
		const block = blueprint.slice(start, next < 0 ? undefined : next);
		return [...block.matchAll(/fromGroup:\s*(\S+)/g)].map((m) => m[1] ?? "");
	}

	it("links each service to the groups setup:render creates for it, covering SERVICE_ENV", () => {
		for (const service of ["gateway", "workflows"] as const) {
			const expected = ENV_GROUPS.filter((g) => g.services.includes(service));
			expect(linkedGroups(`factory-${service}`).sort()).toEqual(expected.map((g) => g.name).sort());
			const keys = [...expected.flatMap((g) => g.keys), "RENDER_WORKFLOW_SLUG"];
			expect(keys.filter((k) => SERVICE_ENV[service].includes(k)).sort()).toEqual([...SERVICE_ENV[service]].sort());
		}
	});
});
