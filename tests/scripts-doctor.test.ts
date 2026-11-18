import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../app/db/index.js";
import { type DoctorOptions, runDoctor } from "../scripts/lib/doctor.js";
import { type CheckResult, Reporter } from "../scripts/lib/output.js";
import { pgliteDb } from "./helpers/db.js";
import { fakeFetch, json, type Routes } from "./helpers/fake-fetch.js";

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
const GATEWAY_HOOK = "https://gw.onrender.com/webhooks/github";
const DELIVERY = { id: 1, delivered_at: "2026-10-28T11:59:00Z", status_code: 202, event: "issues" };
const LARGE_DELIVERY_ID = "3851307323039416300";
const tasks = (names: string[]) => names.map((name, i) => ({ task: { id: `tsk-${i}`, name }, cursor: `c${i}` }));

const HEALTHY: Routes = {
	"GET /repos/acme/web": { full_name: "acme/web", has_issues: true, archived: false },
	"GET /app": APP,
	"GET /app/hook/config": { url: GATEWAY_HOOK, content_type: "json", insecure_ssl: "0", secret: "********" },
	"GET /app/hook/deliveries": [DELIVERY],
	"GET /app/hook/deliveries/1": { ...DELIVERY, url: GATEWAY_HOOK },
	[`GET /app/hook/deliveries/${LARGE_DELIVERY_ID}`]: new Response(
		`{"id":${LARGE_DELIVERY_ID},"delivered_at":"2026-10-30T23:58:45.856Z","status_code":202,"event":"ping","url":"${GATEWAY_HOOK}"}`,
	),
	"GET /repos/acme/web/installation": { id: 7, permissions: APP.permissions, events: APP.events },
	"POST /app/installations/7/access_tokens": () => json({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201),
	"GET /repos/acme/web/labels": LABEL_NAMES.map((name) => ({ name, color: "000000", description: null })),
	"GET /v1/tasks": tasks(["triage", "spec-to-pr", "pr-review", "autopilot", "cancel", "refresh-snapshot"]),
};

async function doctor(overrides: Partial<DoctorOptions> & { routes?: Routes } = {}) {
	const { routes, ...rest } = overrides;
	const lines: string[] = [];
	const out = new Reporter((line) => lines.push(line));
	const code = await runDoctor(
		{
			env: FULL_ENV,
			fetch: fakeFetch({ ...HEALTHY, ...routes }).fetch,
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
		const { code, find } = await doctor({ routes: { "GET /repos/acme/web": { full_name: "acme/web", has_issues: false, archived: false } } });
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
			routes: { "GET /app": { ...APP, permissions: { ...APP.permissions, contents: "read" }, events: ["issues", "pull_request"] } },
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
		const { code, find } = await doctor({ routes: { "GET /v1/tasks": new Response("not json") } });
		expect(code).toBe(1);
		expect(find("fail", "invalid task list")).toBeDefined();
	});

	it.each([
		["no tasks", tasks([]), "no tasks found"],
		["partial registration", tasks(["triage"]), "tasks not registered"],
		["unreachable API", new Error(`connection failed ${SECRETS.RENDER_API_KEY}`), "Render API unreachable"],
		["rejected key", json({ message: "nope" }, 401), "rejected"],
	])("blocks readiness for %s", async (_, reply, message) => {
		const { code, find } = await doctor({ routes: { "GET /v1/tasks": reply } });
		expect(code).toBe(1);
		expect(find("fail", message)).toBeDefined();
	});

	it("fails when installed permissions or events have not been accepted", async () => {
		const { code, find } = await doctor({
			routes: { "GET /repos/acme/web/installation": { id: 7, permissions: { metadata: "read" }, events: ["push"] } },
		});
		expect(code).toBe(1);
		expect(find("fail", "installation hasn't granted")).toBeDefined();
		expect(find("fail", "installation isn't receiving")).toBeDefined();
	});

	it.each([
		["no history", { "GET /app/hook/deliveries": [] }, "no deliveries yet"],
		[
			"different target",
			{ "GET /app/hook/deliveries/1": { ...DELIVERY, url: "https://placeholder.example.com/webhooks/github" } },
			"not sent to the configured gateway",
		],
		["a rejected delivery", { "GET /app/hook/deliveries/1": { ...DELIVERY, url: GATEWAY_HOOK, status_code: 401 } }, "signature"],
	] satisfies [string, Routes, string][])("does not mistake %s for verified webhook delivery", async (_, routes, message) => {
		const { code, find } = await doctor({ routes });
		expect(code).toBe(1);
		expect(find("fail", message)).toBeDefined();
	});

	it("reports a successful delivery as historical evidence without claiming the hook is currently active", async () => {
		const { code, output } = await doctor({
			routes: { "GET /app/hook/deliveries/1": { ...DELIVERY, url: GATEWAY_HOOK, delivered_at: "2026-10-26T00:00:00Z" } },
		});
		expect(code).toBe(0);
		expect(output).toContain("latest delivery to the configured gateway (issues, 2026-10-26T00:00:00Z) got 202");
		expect(output).not.toContain("webhook is active");
	});

	it("verifies a delivery whose ID exceeds Number.MAX_SAFE_INTEGER", async () => {
		const deliveries = `[{"id":${LARGE_DELIVERY_ID},"delivered_at":"2026-10-30T23:58:45.856Z","status_code":202,"event":"ping"}]`;
		const { code, find } = await doctor({ routes: { "GET /app/hook/deliveries": new Response(deliveries) } });
		expect(code).toBe(0);
		expect(find("pass", "latest delivery to the configured gateway (ping, 2026-10-30T23:58:45.856Z) got 202")).toBeDefined();
	});

	it("never prints a secret, even when everything fails", async () => {
		const { output } = await doctor({
			routes: {
				"GET /app": { ...APP, permissions: {}, events: [] },
				"GET /app/hook/config": { url: "nope", content_type: "form", secret: "********" },
				"GET /app/hook/deliveries": [{ id: 3, delivered_at: "x", status_code: 500, event: "push" }],
				"GET /repos/acme/web/labels": [],
				"GET /v1/tasks": new Error(`connection failed ${SECRETS.RENDER_API_KEY}`),
			},
		});
		expectNoSecrets(output);
	});
});
