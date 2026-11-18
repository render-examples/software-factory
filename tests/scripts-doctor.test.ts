import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../app/db/index.js";
import { type DoctorOptions, runDoctor } from "../scripts/lib/doctor.js";
import { type CheckResult, Reporter } from "../scripts/lib/output.js";
import { pgliteDb } from "./helpers/db.js";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const PRIVATE_KEY_B64 = Buffer.from(privateKey).toString("base64");

const TOKEN = "ghs_installationTOKEN123";
const DB_PASSWORD = "db-SECRET-password";
const SECRETS = {
	GITHUB_WEBHOOK_SECRET: "whsec-super-secret-value",
	EVENTS_READ_TOKEN: "events-reader-SECRET-token",
	RENDER_API_KEY: "rnd_renderSECRETkey",
	ANTHROPIC_API_KEY: "sk-ant-SECRET-model-key",
	GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_B64,
	DATABASE_URL: `postgresql://factory:${DB_PASSWORD}@dpg-abc/factory`,
};

let db: Db;
beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
/** The migrated test database, left open when doctor closes its connection. */
const openTestDb = () => ({ ...db, end: async () => {} });

const FULL_ENV = {
	...SECRETS,
	RENDER_WORKFLOW_SLUG: "factory-workflows",
	RENDER_WORKSPACE_ID: "tea-abc123",
	GITHUB_APP_ID: "1",
};

const APP = {
	id: 1,
	slug: "sf",
	name: "sf",
	html_url: "https://github.com/apps/sf",
	owner: { login: "acme", type: "Organization" },
	permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
	events: ["issues", "issue_comment", "pull_request", "push"],
};
const LABEL_NAMES = ["factory:triage", "factory:spec-approved", "factory:pr-review", "factory:autopilot", "factory:working"];
const DELIVERY = { id: 1, delivered_at: "2026-10-28T11:59:00Z", status_code: 202, event: "issues" };
const LARGE_DELIVERY_ID = "3851307323039416300";
const TASK_NAMES = ["triage", "spec-to-pr", "pr-review", "autopilot", "cancel", "refresh-snapshot"];

interface World {
	app?: Omit<typeof APP, "permissions"> & { permissions: Record<string, string> };
	hook?: Record<string, unknown>;
	deliveries?: { id: number; delivered_at: string; status_code: number; event: string }[];
	installed?: boolean;
	installation?: { permissions: Record<string, string>; events: string[] };
	delivery?: unknown;
	deliveriesJson?: string;
	labels?: string[];
	repositoryResponse?: { status?: number; body: unknown };
	tasks?: string[];
	tasksStatus?: number;
	tasksJson?: string;
	tasksUnreachable?: boolean;
}

function fakeFetch(world: World = {}) {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		switch (`${method} ${url.host}${url.pathname}`) {
			case "GET api.github.com/repos/acme/web":
				if (world.repositoryResponse) return json(world.repositoryResponse.body, world.repositoryResponse.status);
				return json({ full_name: "acme/web", has_issues: true, archived: false });
			case "GET api.github.com/app":
				return json(world.app ?? APP);
			case "GET api.github.com/app/hook/config":
				return json(
					world.hook ?? {
						url: "https://gw.onrender.com/webhooks/github",
						content_type: "json",
						insecure_ssl: "0",
						secret: "********",
					},
				);
			case "GET api.github.com/app/hook/deliveries":
				if (world.deliveriesJson !== undefined) return new Response(world.deliveriesJson);
				return json(world.deliveries ?? [DELIVERY]);
			case "GET api.github.com/app/hook/deliveries/1":
				return json(world.delivery ?? { ...DELIVERY, url: "https://gw.onrender.com/webhooks/github" });
			case `GET api.github.com/app/hook/deliveries/${LARGE_DELIVERY_ID}`:
				return new Response(
					`{"id":${LARGE_DELIVERY_ID},"delivered_at":"2026-10-30T23:58:45.856Z","status_code":202,"event":"ping","url":"https://gw.onrender.com/webhooks/github"}`,
				);
			case "GET api.github.com/repos/acme/web/installation":
				return world.installed === false
					? json({ message: "Not Found" }, 404)
					: json({ id: 7, ...(world.installation ?? { permissions: APP.permissions, events: APP.events }) });
			case "POST api.github.com/app/installations/7/access_tokens":
				return json({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
			case "GET api.github.com/repos/acme/web/labels":
				return json((world.labels ?? LABEL_NAMES).map((name) => ({ name, color: "000000", description: null })));
			case "GET api.render.com/v1/tasks":
				if (world.tasksUnreachable) throw new Error(`connection failed ${SECRETS.RENDER_API_KEY}`);
				if (world.tasksStatus) return json({ message: "nope" }, world.tasksStatus);
				if (world.tasksJson !== undefined) return new Response(world.tasksJson);
				return json((world.tasks ?? TASK_NAMES).map((name, i) => ({ task: { id: `tsk-${i}`, name }, cursor: `c${i}` })));
			default:
				return json({ message: "Not Found" }, 404);
		}
	}) as typeof globalThis.fetch;
}

async function doctor(overrides: Partial<DoctorOptions> & { world?: World } = {}) {
	const { world, ...rest } = overrides;
	const lines: string[] = [];
	const out = new Reporter((line) => lines.push(line));
	const code = await runDoctor(
		{
			env: FULL_ENV,
			fetch: fakeFetch(world),
			sleep: async () => {},
			openDb: openTestDb,
			services: ["gateway", "workflows"],
			repos: ["acme/web"],
			...rest,
		},
		out,
	);
	const output = lines.join("\n");
	const find = (level: CheckResult["level"], text: string) => out.results.find((r) => r.level === level && r.message.includes(text));
	return { code, output, results: out.results, find };
}

function expectNoSecrets(output: string) {
	for (const value of [...Object.values(SECRETS), TOKEN, DB_PASSWORD, privateKey.split("\n")[1] ?? ""]) {
		expect(output).not.toContain(value);
	}
}

describe("doctor", () => {
	it("blocks readiness when Issues is disabled even with an installed App and existing labels", async () => {
		const { code, find } = await doctor({ world: { repositoryResponse: { body: { full_name: "acme/web", has_issues: false, archived: false } } } });
		expect(code).toBe(1);
		expect(find("fail", "acme/web: Issues is disabled")).toBeDefined();
	});

	it("checks the configured base branch and blocks readiness when it is inaccessible", async () => {
		const { code, find } = await doctor({ baseBranches: { "acme/web": "release/candidate" } });
		expect(code).toBe(1);
		expect(find("fail", "base branch release/candidate is missing or inaccessible")).toBeDefined();
	});

	it("passes a healthy deployment and exits 0", async () => {
		const { code, results, output } = await doctor();
		expect(results.filter((r) => r.level === "fail" || r.level === "warn")).toEqual([]);
		expect(code).toBe(0);
		expectNoSecrets(output);
	});

	it("fails when the App lacks a permission or event", async () => {
		const { find } = await doctor({
			world: {
				app: { ...APP, permissions: { ...APP.permissions, contents: "read" }, events: ["issues", "pull_request"] },
			},
		});
		expect(find("fail", "App lacks permissions: contents:write")).toBeDefined();
		expect(find("fail", "issue_comment, push")).toBeDefined();
	});

	it("keeps the gateway's intentional lack of App credentials as a skip", async () => {
		const { code, find } = await doctor({
			services: ["gateway"],
			env: {
				RENDER_API_KEY: SECRETS.RENDER_API_KEY,
				GITHUB_WEBHOOK_SECRET: SECRETS.GITHUB_WEBHOOK_SECRET,
				EVENTS_READ_TOKEN: SECRETS.EVENTS_READ_TOKEN,
				RENDER_WORKFLOW_SLUG: "factory-workflows",
				DATABASE_URL: SECRETS.DATABASE_URL,
			},
		});
		expect(code).toBe(0);
		expect(find("skip", "no App credentials")).toBeDefined();
	});

	it("blocks readiness when the database is unreachable, without printing its password", async () => {
		const unreachable = new Error(`connect ECONNREFUSED for factory:${DB_PASSWORD}`);
		const { code, find, output } = await doctor({
			openDb: () => ({ query: () => Promise.reject(unreachable), withTx: () => Promise.reject(unreachable), end: async () => {} }),
		});
		expect(code).toBe(1);
		expect(find("fail", "database check failed")).toBeDefined();
		expectNoSecrets(output);
	});

	it("warns about migrations the database hasn't applied yet", async () => {
		const { db: behind } = await pgliteDb();
		await behind.query("delete from schema_migrations");
		const { code, find } = await doctor({ openDb: () => behind });
		expect(code).toBe(0);
		expect(find("warn", "migrations not applied yet: 001_events.sql")).toBeDefined();
	});

	it("fails when a service lacks DATABASE_URL", async () => {
		const { DATABASE_URL: _, ...env } = FULL_ENV;
		const { code, find } = await doctor({ env });
		expect(code).toBe(1);
		expect(find("fail", "DATABASE_URL is not set")).toBeDefined();
	});

	it("points Workflows' missing DATABASE_URL at setup:render --link-database", async () => {
		const { DATABASE_URL: _, ...env } = FULL_ENV;
		const { find } = await doctor({ env, services: ["workflows"] });
		expect(find("fail", "DATABASE_URL is not set")?.fix).toContain("npm run setup:render -- --link-database");
	});

	it("fails without crashing on an invalid task response", async () => {
		const { code, find } = await doctor({ world: { tasksJson: "not json" } });
		expect(code).toBe(1);
		expect(find("fail", "invalid task list")).toBeDefined();
	});

	it.each([
		["no tasks", { tasks: [] }, "no tasks found"],
		["partial registration", { tasks: ["triage"] }, "tasks not registered"],
		["unreachable API", { tasksUnreachable: true }, "Render API unreachable"],
		["rejected key", { tasksStatus: 401 }, "rejected"],
	] satisfies [string, World, string][])("blocks readiness for %s", async (_, world, message) => {
		const { code, find } = await doctor({ world });
		expect(code).toBe(1);
		expect(find("fail", message)).toBeDefined();
	});

	it("fails when installed permissions or events have not been accepted", async () => {
		const { code, find } = await doctor({ world: { installation: { permissions: { metadata: "read" }, events: ["push"] } } });
		expect(code).toBe(1);
		expect(find("fail", "installation hasn't granted")).toBeDefined();
		expect(find("fail", "installation isn't receiving")).toBeDefined();
	});

	it.each([
		["no history", { deliveries: [] }, "no deliveries yet"],
		["different target", { delivery: { ...DELIVERY, url: "https://placeholder.example.com/webhooks/github" } }, "not sent to the configured gateway"],
		["a rejected delivery", { delivery: { ...DELIVERY, url: "https://gw.onrender.com/webhooks/github", status_code: 401 } }, "signature"],
	] satisfies [string, World, string][])("does not mistake %s for verified webhook delivery", async (_, world, message) => {
		const { code, find } = await doctor({ world });
		expect(code).toBe(1);
		expect(find("fail", message)).toBeDefined();
	});

	it("reports a successful delivery as historical evidence without claiming the hook is currently active", async () => {
		const { code, output } = await doctor({
			world: { delivery: { ...DELIVERY, url: "https://gw.onrender.com/webhooks/github", delivered_at: "2026-10-26T00:00:00Z" } },
		});
		expect(code).toBe(0);
		expect(output).toContain("latest delivery to the configured gateway (issues, 2026-10-26T00:00:00Z) got 202");
		expect(output).not.toContain("webhook is active");
	});

	it("verifies a delivery whose ID exceeds Number.MAX_SAFE_INTEGER", async () => {
		const { code, find } = await doctor({
			world: { deliveriesJson: `[{"id":${LARGE_DELIVERY_ID},"delivered_at":"2026-10-30T23:58:45.856Z","status_code":202,"event":"ping"}]` },
		});
		expect(code).toBe(0);
		expect(find("pass", "latest delivery to the configured gateway (ping, 2026-10-30T23:58:45.856Z) got 202")).toBeDefined();
	});

	it("never prints a secret, even when everything fails", async () => {
		const { output } = await doctor({
			world: {
				app: { ...APP, permissions: {}, events: [] },
				hook: { url: "nope", content_type: "form", secret: "********" },
				deliveries: [{ id: 3, delivered_at: "x", status_code: 500, event: "push" }],
				labels: [],
				tasksUnreachable: true,
			},
		});
		expectNoSecrets(output);
	});
});
