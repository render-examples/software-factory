import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Reporter } from "../scripts/lib/output.js";
import { ENV_GROUPS, SERVICE_ENV, WORKFLOWS_DATABASE_GROUP } from "../scripts/lib/requirements.js";
import { linkDatabase, setupRender } from "../scripts/lib/setup-render.js";
import { type FakeRequest, fakeFetch, json } from "./helpers/fake-fetch.js";

const WORKSPACE = "tea-abc123";
const SECRETS = {
	RENDER_API_KEY: "rnd_renderSECRETkey",
	GITHUB_WEBHOOK_SECRET: "whsec-super-secret-value",
	EVENTS_READ_TOKEN: "events-reader-SECRET-token",
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

interface StoredService {
	id: string;
	name: string;
	envVars: { key: string; value: string }[];
}

/** A Render API with an in-memory set of env groups and web services. Unknown groups, services, and keys fall through to a 404. */
function renderWorld(opts: { groups?: StoredGroup[]; services?: StoredService[]; owner?: Response } = {}) {
	const groups = opts.groups ?? [];
	const services = opts.services ?? [];
	const api = fakeFetch({
		[`GET /v1/owners/${WORKSPACE}`]: opts.owner ?? { id: WORKSPACE, name: "Acme", type: "team" },
		"GET /v1/env-groups": ({ url }) =>
			groups
				.filter((g) => g.name.includes(url.searchParams.get("name") ?? ""))
				.map(({ envVars: _, ...envGroup }) => ({ cursor: envGroup.id, envGroup })),
		"POST /v1/env-groups": ({ body }) => {
			const group = { ...(body as Omit<StoredGroup, "id">), id: `evg-${groups.length + 1}` };
			groups.push(group);
			return json(group, 201);
		},
		"GET /v1/env-groups/:id": (_, { id }) => groups.find((g) => g.id === id),
		"PUT /v1/env-groups/:id/env-vars/:key": ({ body }, { id, key }) => {
			const group = groups.find((g) => g.id === id);
			if (group) group.envVars = [...group.envVars.filter((v) => v.key !== key), { key, value: (body as { value: string }).value }];
			return group;
		},
		"GET /v1/services": ({ url }) => {
			if (url.searchParams.get("ownerId") !== WORKSPACE) return undefined;
			const start = services.findIndex((s) => s.id === url.searchParams.get("cursor")) + 1;
			return services
				.slice(start, start + Number(url.searchParams.get("limit")))
				.map(({ id, name }) => ({ cursor: id, service: { id, name, type: "web_service", ownerId: WORKSPACE } }));
		},
		"GET /v1/services/:id/env-vars/:key": (_, { id, key }) => services.find((s) => s.id === id)?.envVars.find((v) => v.key === key),
	});
	return { ...api, groups, services };
}

async function run(world: ReturnType<typeof renderWorld>, env: Record<string, string | undefined> = ENV) {
	const lines: string[] = [];
	const code = await setupRender({ env, fetch: world.fetch }, new Reporter((line) => lines.push(line)));
	return { code, output: lines.join("\n") };
}

const writes = (requests: FakeRequest[]) => requests.filter((r) => r.method !== "GET");

describe("setup:render", () => {
	it("creates each group with exactly its keys, and keeps App and model credentials off the gateway", async () => {
		const world = renderWorld();
		const { code, output } = await run(world);
		expect(code).toBe(0);

		const byName = Object.fromEntries(world.groups.map((g) => [g.name, Object.fromEntries(g.envVars.map((v) => [v.key, v.value]))]));
		expect(byName).toEqual({
			"software-factory-shared": { RENDER_API_KEY: SECRETS.RENDER_API_KEY },
			"software-factory-gateway": { GITHUB_WEBHOOK_SECRET: SECRETS.GITHUB_WEBHOOK_SECRET, EVENTS_READ_TOKEN: SECRETS.EVENTS_READ_TOKEN },
			"software-factory-workflows": {
				RENDER_WORKSPACE_ID: WORKSPACE,
				GITHUB_APP_ID: "1",
				GITHUB_APP_PRIVATE_KEY: SECRETS.GITHUB_APP_PRIVATE_KEY,
				ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY,
			},
		});
		expect(world.groups.every((g) => g.ownerId === WORKSPACE)).toBe(true);
		expect(world.requests.every((r) => r.headers.get("Authorization") === `Bearer ${SECRETS.RENDER_API_KEY}`)).toBe(true);
		for (const secret of Object.values(SECRETS)) expect(output).not.toContain(secret);
	});

	it("writes nothing when a value is missing", async () => {
		const world = renderWorld();
		const { code, output } = await run(world, { ...ENV, ANTHROPIC_API_KEY: "" });
		expect(code).toBe(1);
		expect(output).toContain("ANTHROPIC_API_KEY is not set");
		expect(world.requests).toEqual([]);
	});

	it("updates only changed keys and leaves keys it doesn't manage alone", async () => {
		const world = renderWorld({
			groups: [
				{ id: "evg-a", name: "software-factory-shared", ownerId: WORKSPACE, envVars: [{ key: "RENDER_API_KEY", value: SECRETS.RENDER_API_KEY }] },
				{
					id: "evg-b",
					name: "software-factory-gateway",
					ownerId: WORKSPACE,
					envVars: [
						{ key: "GITHUB_WEBHOOK_SECRET", value: "old" },
						{ key: "EVENTS_READ_TOKEN", value: SECRETS.EVENTS_READ_TOKEN },
					],
				},
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
		expect(world.groups.find((g) => g.id === "evg-b")?.envVars).toContainEqual({
			key: "GITHUB_WEBHOOK_SECRET",
			value: SECRETS.GITHUB_WEBHOOK_SECRET,
		});
		expect(world.groups.find((g) => g.id === "evg-c")?.envVars).toContainEqual({ key: "GITHUB_API_URL", value: "https://ghe.example.com/api/v3" });

		const again = renderWorld({ groups: world.groups });
		await run(again);
		expect(writes(again.requests)).toEqual([]);
	});

	it("refuses to pick between two groups with the same name", async () => {
		const duplicate = { name: "software-factory-gateway", ownerId: WORKSPACE, envVars: [] };
		const world = renderWorld({
			groups: [
				{ ...duplicate, id: "evg-1" },
				{ ...duplicate, id: "evg-2" },
			],
		});
		const { code, output } = await run(world);
		expect(code).toBe(1);
		expect(output).toContain("2 env groups are named software-factory-gateway");
		expect(world.groups.filter((g) => g.name === "software-factory-gateway")).toHaveLength(2);
		expect(writes(world.requests).filter((r) => /evg-[12]/.test(r.url.pathname))).toEqual([]);
	});

	it("stops before any group work when the API key is rejected", async () => {
		const world = renderWorld({ owner: json({ message: "nope" }, 401) });
		const { code, output } = await run(world);
		expect(code).toBe(1);
		expect(output).toContain("RENDER_API_KEY was rejected");
		expect(world.requests).toHaveLength(1);
	});
});

describe("setup:render --link-database", () => {
	const DATABASE_URL = "postgresql://factory:db-SECRET-password@dpg-abc123-a/factory_db_ygz3";
	const LINK_ENV = { RENDER_API_KEY: SECRETS.RENDER_API_KEY, RENDER_WORKSPACE_ID: WORKSPACE };
	const workflowsGroup = (): StoredGroup => ({
		id: "evg-w",
		name: "software-factory-workflows",
		ownerId: WORKSPACE,
		envVars: [{ key: "GITHUB_APP_ID", value: "1" }],
	});
	/** More than one page of other web services, then the Blueprint's gateway under a suffixed name. */
	const servicesWithGateway = (envVars: StoredService["envVars"]): StoredService[] => [
		...Array.from({ length: 100 }, (_, i) => ({ id: `srv-${i}`, name: `app-${i}`, envVars: [] })),
		{ id: "srv-gw", name: "factory-gateway-ygz3", envVars },
	];

	async function link(world: ReturnType<typeof renderWorld>) {
		const lines: string[] = [];
		const code = await linkDatabase({ env: LINK_ENV, fetch: world.fetch }, new Reporter((line) => lines.push(line)));
		return { code, output: lines.join("\n") };
	}

	it("copies the gateway's DATABASE_URL into the workflows group without printing it, and is idempotent", async () => {
		const world = renderWorld({ groups: [workflowsGroup()], services: servicesWithGateway([{ key: "DATABASE_URL", value: DATABASE_URL }]) });
		const { code, output } = await link(world);
		expect(code).toBe(0);
		expect(world.groups[0]?.envVars).toEqual([
			{ key: "GITHUB_APP_ID", value: "1" },
			{ key: "DATABASE_URL", value: DATABASE_URL },
		]);
		expect(writes(world.requests).map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["PUT /v1/env-groups/evg-w/env-vars/DATABASE_URL"]);
		expect(output).toContain("DATABASE_URL added");
		expect(output).toContain("factory-workflows picks up DATABASE_URL on its next deploy");
		expect(output).not.toContain(DATABASE_URL);
		expect(output).not.toContain("db-SECRET-password");

		const again = renderWorld({ groups: world.groups, services: world.services });
		const rerun = await link(again);
		expect(rerun.code).toBe(0);
		expect(rerun.output).toContain("DATABASE_URL unchanged");
		expect(writes(again.requests)).toEqual([]);
	});

	it.each([
		["doesn't exist yet", [{ id: "srv-1", name: "other-app", envVars: [] }], `no factory-gateway service in workspace ${WORKSPACE}`],
		["has no DATABASE_URL", servicesWithGateway([]), "factory-gateway-ygz3 has no DATABASE_URL"],
	] satisfies [string, StoredService[], string][])("fails without writing when the gateway %s", async (_, services, message) => {
		const world = renderWorld({ groups: [workflowsGroup()], services });
		const { code, output } = await link(world);
		expect(code).toBe(1);
		expect(output).toContain(message);
		expect(output).toContain("Apply the Blueprint first");
		expect(writes(world.requests)).toEqual([]);
	});

	it("refuses to pick between two services that could be the gateway", async () => {
		const envVars = [{ key: "DATABASE_URL", value: DATABASE_URL }];
		const world = renderWorld({
			groups: [workflowsGroup()],
			services: [
				{ id: "srv-1", name: "factory-gateway", envVars },
				{ id: "srv-2", name: "factory-gateway-ygz3", envVars },
			],
		});
		const { code, output } = await link(world);
		expect(code).toBe(1);
		expect(output).toContain("2 web services could be the gateway: factory-gateway, factory-gateway-ygz3");
		expect(writes(world.requests)).toEqual([]);
	});
});

describe("render.yaml env groups", () => {
	const blueprint = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");

	/** One service's block of render.yaml, up to the next service or the databases. */
	function serviceBlock(service: string): string {
		const start = blueprint.search(new RegExp(`- type: \\w+\\n\\s+name: ${service}\\n`));
		const next = blueprint.slice(start + 1).search(/- type:|databases:/);
		return blueprint.slice(start, next < 0 ? undefined : start + 1 + next);
	}

	it("links each service to the groups setup:render creates for it and factory-db to the gateway, covering SERVICE_ENV", () => {
		for (const service of ["gateway", "workflows"] as const) {
			const block = serviceBlock(`factory-${service}`);
			const expected = ENV_GROUPS.filter((g) => g.services.includes(service));
			expect([...block.matchAll(/fromGroup:\s*(\S+)/g)].map((m) => m[1]).sort()).toEqual(expected.map((g) => g.name).sort());
			const keys = [...expected.flatMap((g) => g.keys), "RENDER_WORKFLOW_SLUG", "DATABASE_URL"];
			expect(keys.filter((k) => SERVICE_ENV[service].includes(k)).sort()).toEqual([...SERVICE_ENV[service]].sort());
		}
		expect(serviceBlock("factory-gateway")).toMatch(/key: DATABASE_URL\n\s+fromDatabase:\n\s+name: factory-db\n/);
		const workflows = serviceBlock("factory-workflows");
		expect(workflows).not.toMatch(/key: DATABASE_URL/);
		expect(workflows).toContain(`fromGroup: ${WORKFLOWS_DATABASE_GROUP.name}\n`);
	});
});
