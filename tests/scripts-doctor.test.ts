import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type DbClient, type DoctorOptions, runDoctor } from "../scripts/lib/doctor.js";
import { PLACEHOLDER_WEBHOOK_URL } from "../scripts/lib/manifest.js";
import { type CheckResult, Reporter } from "../scripts/lib/output.js";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const PRIVATE_KEY_B64 = Buffer.from(privateKey).toString("base64");

const TOKEN = "ghs_installationTOKEN123";
const SECRETS = {
	DATABASE_URL: "postgresql://factory:pgSECRETpw@db.internal:5432/factory",
	GITHUB_WEBHOOK_SECRET: "whsec-super-secret-value",
	FACTORY_ADMIN_TOKEN: "admin-token-secret-value",
	RENDER_API_KEY: "rnd_renderSECRETkey",
	ANTHROPIC_API_KEY: "sk-ant-SECRET-model-key",
	GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_B64,
};

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
const LABEL_NAMES = ["factory:triage", "factory:spec-approved", "factory:pr-review", "factory:working"];
const TASK_NAMES = ["triage", "spec-to-pr", "pr-review", "cancel", "refresh-snapshot"];

interface Call {
	method: string;
	url: URL;
	auth: string;
}

interface World {
	app?: Omit<typeof APP, "permissions"> & { permissions: Record<string, string> };
	hook?: Record<string, unknown>;
	deliveries?: { id: number; delivered_at: string; status_code: number; event: string }[];
	installed?: boolean;
	labels?: string[];
	labelsResponse?: { status: number; body: unknown };
	tasks?: string[];
	tasksStatus?: number;
}

function fakeFetch(world: World = {}) {
	const calls: Call[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const method = init?.method ?? "GET";
		calls.push({ method, url, auth: headers.Authorization ?? "" });
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		switch (`${method} ${url.host}${url.pathname}`) {
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
				return json(world.deliveries ?? [{ id: 1, delivered_at: "2026-10-18T00:00:00Z", status_code: 202, event: "issues" }]);
			case "GET api.github.com/repos/acme/web/installation":
				return world.installed === false
					? json({ message: "Not Found" }, 404)
					: json({ id: 7, permissions: APP.permissions, events: APP.events });
			case "POST api.github.com/app/installations/7/access_tokens":
				return json({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
			case "GET api.github.com/repos/acme/web/labels":
				if (world.labelsResponse) return json(world.labelsResponse.body, world.labelsResponse.status);
				return json((world.labels ?? LABEL_NAMES).map((name) => ({ name, color: "000000", description: null })));
			case "GET api.render.com/v1/tasks":
				if (world.tasksStatus) return json({ message: "nope" }, world.tasksStatus);
				return json((world.tasks ?? TASK_NAMES).map((name, i) => ({ task: { id: `tsk-${i}`, name }, cursor: `c${i}` })));
			default:
				return json({ message: "Not Found" }, 404);
		}
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

function fakeDb(opts: { events?: boolean; migrations?: string[] | null; unreachable?: boolean } = {}) {
	const queries: string[] = [];
	const connectDb = async (): Promise<DbClient> => {
		if (opts.unreachable) throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
		return {
			async query<T>(sql: string) {
				queries.push(sql);
				if (sql.includes("to_regclass")) {
					return {
						rows: [
							{
								events: opts.events === false ? null : "events",
								migrations: opts.migrations === null ? null : "schema_migrations",
							},
						] as T[],
					};
				}
				if (sql.includes("from schema_migrations")) {
					return { rows: (opts.migrations ?? ["0001_events.sql"]).map((filename) => ({ filename })) as T[] };
				}
				throw new Error(`unexpected query: ${sql}`);
			},
			async end() {},
		};
	};
	return { connectDb, queries };
}

async function doctor(overrides: Partial<DoctorOptions> & { world?: World; db?: ReturnType<typeof fakeDb> } = {}) {
	const { world, db, ...rest } = overrides;
	const fake = fakeFetch(world);
	const lines: string[] = [];
	const out = new Reporter((line) => lines.push(line));
	const code = await runDoctor(
		{
			env: FULL_ENV,
			fetch: fake.fetch,
			sleep: async () => {},
			services: ["gateway", "workflows"],
			repos: ["acme/web"],
			models: { small: "anthropic/haiku", medium: "anthropic/sonnet", large: "anthropic/opus" },
			migrations: ["0001_events.sql"],
			connectDb: (db ?? fakeDb()).connectDb,
			...rest,
		},
		out,
	);
	const output = lines.join("\n");
	const find = (level: CheckResult["level"], text: string) =>
		out.results.find((r) => r.level === level && r.message.includes(text));
	return { code, output, results: out.results, find, calls: fake.calls };
}

function expectNoSecrets(output: string) {
	for (const value of [...Object.values(SECRETS), TOKEN, "pgSECRETpw", privateKey.split("\n")[1] ?? ""]) {
		expect(output).not.toContain(value);
	}
}

describe("doctor", () => {
	it("passes a healthy deployment and exits 0", async () => {
		const { code, results, output } = await doctor();
		expect(results.filter((r) => r.level === "fail" || r.level === "warn")).toEqual([]);
		expect(code).toBe(0);
		expectNoSecrets(output);
	});

	it("checks each service's env vars exactly as render.yaml declares them", async () => {
		const gw = await doctor({ services: ["gateway"], env: { ...FULL_ENV, FACTORY_ADMIN_TOKEN: "" } });
		expect(gw.find("fail", "FACTORY_ADMIN_TOKEN is not set")).toBeDefined();
		expect(gw.output).not.toContain("GITHUB_APP_ID is set");
		expect(gw.code).toBe(1);

		const wf = await doctor({ services: ["workflows"], env: { ...FULL_ENV, FACTORY_ADMIN_TOKEN: "" } });
		expect(wf.find("fail", "FACTORY_ADMIN_TOKEN")).toBeUndefined();
		expect(wf.find("pass", "GITHUB_APP_ID is set")).toBeDefined();
		expect(wf.code).toBe(0);
	});

	it("warns, not fails, when the optional RENDER_WORKSPACE_ID is unset, and fails a malformed one", async () => {
		const unset = await doctor({ services: ["workflows"], env: { ...FULL_ENV, RENDER_WORKSPACE_ID: "" } });
		expect(unset.find("warn", "RENDER_WORKSPACE_ID is not set")).toBeDefined();
		expect(unset.code).toBe(0);
		const bad = await doctor({ services: ["workflows"], env: { ...FULL_ENV, RENDER_WORKSPACE_ID: "usr-1" } });
		expect(bad.find("fail", "RENDER_WORKSPACE_ID is not a workspace ID")).toBeDefined();
	});

	it("skips GitHub checks on the gateway, which holds no App credentials", async () => {
		const { GITHUB_APP_ID: _id, GITHUB_APP_PRIVATE_KEY: _key, ANTHROPIC_API_KEY: _model, ...gatewayEnv } = FULL_ENV;
		const { code, find, calls } = await doctor({ services: ["gateway"], env: gatewayEnv });
		expect(find("skip", "GitHub checks")).toBeDefined();
		expect(calls.some((c) => c.url.host === "api.github.com")).toBe(false);
		expect(code).toBe(0);
	});

	it("fails missing model keys for each configured provider", async () => {
		const { find, code, output } = await doctor({
			services: ["workflows"],
			env: { ...FULL_ENV, ANTHROPIC_API_KEY: "" },
			models: { small: "openai/gpt-x", medium: "anthropic/sonnet", large: "anthropic/opus" },
		});
		expect(find("fail", "anthropic (medium, large): ANTHROPIC_API_KEY is not set")).toBeDefined();
		expect(find("fail", "openai (small): OPENAI_API_KEY is not set")).toBeDefined();
		expect(find("warn", "render.yaml doesn't declare OPENAI_API_KEY")).toBeDefined();
		expect(code).toBe(1);
		expectNoSecrets(output);
	});

	it("fails a private key that doesn't parse, without printing it", async () => {
		const garbage = Buffer.from("not a key at all, but secret-ish").toString("base64");
		const { find, output, code } = await doctor({ env: { ...FULL_ENV, GITHUB_APP_PRIVATE_KEY: garbage } });
		expect(find("fail", "GITHUB_APP_PRIVATE_KEY does not parse")).toBeDefined();
		expect(output).not.toContain(garbage);
		expect(code).toBe(1);
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

	it("fails a placeholder or non-/webhooks/github hook URL and a form content type", async () => {
		const placeholder = await doctor({ world: { hook: { url: PLACEHOLDER_WEBHOOK_URL, content_type: "form" } } });
		expect(placeholder.find("fail", "webhook URL is not set to the gateway")).toBeDefined();
		expect(placeholder.find("fail", "content type is form")).toBeDefined();
		const wrongPath = await doctor({ world: { hook: { url: "https://gw.onrender.com/hooks", content_type: "json" } } });
		expect(wrongPath.find("fail", "is not an https …/webhooks/github URL")).toBeDefined();
	});

	it("warns when there are no deliveries and fails when the gateway rejected the signature", async () => {
		const none = await doctor({ world: { deliveries: [] } });
		expect(none.find("warn", "no webhook deliveries yet")).toBeDefined();
		expect(none.code).toBe(0);
		const rejected = await doctor({
			world: { deliveries: [{ id: 2, delivered_at: "2026-10-18T00:00:00Z", status_code: 401, event: "issues" }] },
		});
		expect(rejected.find("fail", "rejected the latest delivery's signature")).toBeDefined();
	});

	it("looks up the installation with the App JWT and reads labels with an installation token", async () => {
		const { calls } = await doctor();
		const lookup = calls.find((c) => c.url.pathname === "/repos/acme/web/installation");
		expect(lookup?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
		const labels = calls.find((c) => c.url.pathname === "/repos/acme/web/labels");
		expect(labels?.auth).toBe(`Bearer ${TOKEN}`);
	});

	it("fails an uninstalled repo with the install link", async () => {
		const { find, code } = await doctor({ world: { installed: false } });
		const result = find("fail", "sf is not installed on acme/web");
		expect(result?.fix).toContain("https://github.com/apps/sf/installations/new");
		expect(code).toBe(1);
	});

	it("fails a missing trigger label and warns about a missing working label", async () => {
		const { find } = await doctor({ world: { labels: ["factory:triage", "factory:spec-approved"] } });
		expect(find("fail", "label factory:pr-review is missing")).toBeDefined();
		expect(find("warn", "label factory:working is missing")).toBeDefined();
	});

	it("redacts an installation token GitHub echoes back in an error", async () => {
		const { output, find } = await doctor({
			world: { labelsResponse: { status: 403, body: { message: `token ${TOKEN} lacks access` } } },
		});
		expect(find("fail", "could not check acme/web")).toBeDefined();
		expectNoSecrets(output);
	});

	it("checks the events table and schema_migrations by filename", async () => {
		const db = fakeDb();
		const ok = await doctor({ db });
		expect(ok.find("pass", "events table exists")).toBeDefined();
		expect(ok.find("pass", "all 1 migration(s) applied")).toBeDefined();
		expect(db.queries.some((q) => q.includes("select filename from schema_migrations"))).toBe(true);

		const pending = await doctor({ db: fakeDb({ migrations: [] }), migrations: ["0001_events.sql", "0002_more.sql"] });
		expect(pending.find("fail", "migrations not applied: 0001_events.sql, 0002_more.sql")).toBeDefined();

		const noTables = await doctor({ db: fakeDb({ events: false, migrations: null }) });
		expect(noTables.find("fail", "events table is missing")).toBeDefined();
		expect(noTables.find("fail", "schema_migrations table is missing")).toBeDefined();
	});

	it("fails an unreachable database without printing the connection string", async () => {
		const { find, output } = await doctor({ db: fakeDb({ unreachable: true }) });
		expect(find("fail", "DATABASE_URL is unreachable")).toBeDefined();
		expectNoSecrets(output);
	});

	it("checks the Workflows tasks the gateway starts, by slug", async () => {
		const ok = await doctor();
		expect(ok.find("pass", "factory-workflows registers")).toBeDefined();
		const tasksCall = ok.calls.find((c) => c.url.host === "api.render.com");
		expect(tasksCall?.url.searchParams.getAll("taskSlug")).toEqual(TASK_NAMES.map((t) => `factory-workflows/${t}`));
		expect(tasksCall?.auth).toBe(`Bearer ${SECRETS.RENDER_API_KEY}`);

		const missing = await doctor({ world: { tasks: ["triage", "cancel"] } });
		expect(missing.find("fail", "spec-to-pr, pr-review, refresh-snapshot")).toBeDefined();

		const unsupported = await doctor({ world: { tasksStatus: 404 } });
		expect(unsupported.find("skip", "task registration")).toBeDefined();
		expect(unsupported.code).toBe(0);

		const badKey = await doctor({ world: { tasksStatus: 401 } });
		expect(badKey.find("fail", "RENDER_API_KEY was rejected")).toBeDefined();
	});

	it("never prints a secret, even when everything fails", async () => {
		const { output } = await doctor({
			world: {
				app: { ...APP, permissions: {}, events: [] },
				hook: { url: "nope", content_type: "form", secret: "********" },
				deliveries: [{ id: 3, delivered_at: "x", status_code: 500, event: "push" }],
				labels: [],
				tasksStatus: 500,
			},
			db: fakeDb({ unreachable: true }),
		});
		expectNoSecrets(output);
	});
});
