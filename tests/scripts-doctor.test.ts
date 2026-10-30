import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type DoctorOptions, runDoctor } from "../scripts/lib/doctor.js";
import { type CheckResult, Reporter } from "../scripts/lib/output.js";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const PRIVATE_KEY_B64 = Buffer.from(privateKey).toString("base64");

const TOKEN = "ghs_installationTOKEN123";
const SECRETS = {
	GITHUB_WEBHOOK_SECRET: "whsec-super-secret-value",
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
const LABEL_NAMES = ["factory:triage", "factory:spec-approved", "factory:pr-review", "factory:autopilot", "factory:working"];
const DELIVERY = { id: 1, delivered_at: "2026-10-28T11:59:00Z", status_code: 202, event: "issues" };
const TASK_NAMES = ["triage", "spec-to-pr", "pr-review", "autopilot", "cancel", "refresh-snapshot"];

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
	installation?: { permissions: Record<string, string>; events: string[] };
	delivery?: unknown;
	deliveryStatus?: number;
	deliveriesStatus?: number;
	labels?: string[];
	labelsResponse?: { status: number; body: unknown };
	repositoryResponse?: { status?: number; body: unknown };
	branchResponse?: { status?: number; body: unknown };
	tasks?: string[];
	tasksStatus?: number;
	tasksBody?: unknown;
	tasksJson?: string;
	tasksUnreachable?: boolean;
}

function fakeFetch(world: World = {}) {
	const calls: Call[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const method = init?.method ?? "GET";
		calls.push({ method, url, auth: headers.Authorization ?? "" });
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		switch (`${method} ${url.host}${url.pathname}`) {
			case "GET api.github.com/repos/acme/web":
				if (world.repositoryResponse) return json(world.repositoryResponse.body, world.repositoryResponse.status);
				return json({ full_name: "acme/web", has_issues: true, archived: false });
			case "GET api.github.com/repos/acme/web/branches/release%2Fcandidate":
				if (world.branchResponse) return json(world.branchResponse.body, world.branchResponse.status);
				return json({ name: "release/candidate", commit: { sha: "a".repeat(40) } });
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
				return json(world.deliveries ?? [DELIVERY], world.deliveriesStatus ?? 200);
			case "GET api.github.com/app/hook/deliveries/1":
				return json(world.delivery ?? { ...DELIVERY, url: "https://gw.onrender.com/webhooks/github" }, world.deliveryStatus ?? 200);
			case "GET api.github.com/repos/acme/web/installation":
				return world.installed === false ? json({ message: "Not Found" }, 404) : json({ id: 7, ...(world.installation ?? { permissions: APP.permissions, events: APP.events }) });
			case "POST api.github.com/app/installations/7/access_tokens":
				return json({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
			case "GET api.github.com/repos/acme/web/labels":
				if (world.labelsResponse) return json(world.labelsResponse.body, world.labelsResponse.status);
				return json((world.labels ?? LABEL_NAMES).map((name) => ({ name, color: "000000", description: null })));
			case "GET api.render.com/v1/tasks":
				if (world.tasksUnreachable) throw new Error(`connection failed ${SECRETS.RENDER_API_KEY}`);
				if (world.tasksStatus) return json({ message: "nope" }, world.tasksStatus);
				if (world.tasksJson !== undefined) return new Response(world.tasksJson);
				if (Object.hasOwn(world, "tasksBody")) return json(world.tasksBody);
				return json((world.tasks ?? TASK_NAMES).map((name, i) => ({ task: { id: `tsk-${i}`, name }, cursor: `c${i}` })));
			default:
				return json({ message: "Not Found" }, 404);
		}
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

async function doctor(overrides: Partial<DoctorOptions> & { world?: World } = {}) {
	const { world, ...rest } = overrides;
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
			...rest,
		},
		out,
	);
	const output = lines.join("\n");
	const find = (level: CheckResult["level"], text: string) => out.results.find((r) => r.level === level && r.message.includes(text));
	return { code, output, results: out.results, find, calls: fake.calls };
}

function expectNoSecrets(output: string) {
	for (const value of [...Object.values(SECRETS), TOKEN, privateKey.split("\n")[1] ?? ""]) {
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
		const { code, find } = await doctor({
			baseBranches: { "acme/web": "release/candidate" },
			world: { branchResponse: { status: 404, body: { message: "Not Found" } } },
		});
		expect(code).toBe(1);
		expect(find("fail", "base branch release/candidate is missing or inaccessible")).toBeDefined();
	});

	it("accepts an accessible non-main base branch", async () => {
		const { code, find } = await doctor({ baseBranches: { "acme/web": "release/candidate" } });
		expect(code).toBe(0);
		expect(find("pass", "base branch release/candidate is accessible")).toBeDefined();
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
			env: { RENDER_API_KEY: SECRETS.RENDER_API_KEY, GITHUB_WEBHOOK_SECRET: SECRETS.GITHUB_WEBHOOK_SECRET, RENDER_WORKFLOW_SLUG: "factory-workflows" },
		});
		expect(code).toBe(0);
		expect(find("skip", "no App credentials")).toBeDefined();
	});

	it.each([
		["null", { tasksBody: null }],
		["object", { tasksBody: {} }],
		["invalid JSON", { tasksJson: "not json" }],
		["missing task", { tasksBody: [{}] }],
		["missing name", { tasksBody: [{ task: {} }] }],
		["non-string name", { tasksBody: [{ task: { name: 1 } }] }],
		["null row", { tasksBody: [null] }],
	] satisfies [string, World][])("fails without crashing on a %s task response", async (_, world) => {
		const { code, find, output } = await doctor({ world });
		expect(code).toBe(1);
		expect(find("fail", "invalid task list")).toBeDefined();
		expectNoSecrets(output);
	});

	it.each([
		["no tasks", { tasks: [] }, "no tasks found"],
		["partial registration", { tasks: ["triage"] }, "tasks not registered"],
		["unreachable API", { tasksUnreachable: true }, "Render API unreachable"],
		["server error", { tasksStatus: 503 }, "returned 503"],
		["rejected key", { tasksStatus: 401 }, "rejected"],
		["forbidden key", { tasksStatus: 403 }, "rejected"],
	] satisfies [string, World, string][])("blocks readiness for %s", async (_, world, message) => {
		const { code, find, output } = await doctor({ world });
		expect(code).toBe(1);
		expect(find("fail", message)).toBeDefined();
		expectNoSecrets(output);
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
		["failed attempt", { delivery: { ...DELIVERY, url: "https://gw.onrender.com/webhooks/github", status_code: 502 } }, "got 502"],
		["signature rejection", { delivery: { ...DELIVERY, url: "https://gw.onrender.com/webhooks/github", status_code: 401 } }, "signature"],
		["unavailable history", { deliveriesStatus: 503 }, "unverified"],
		["invalid metadata", { delivery: { secret: SECRETS.GITHUB_WEBHOOK_SECRET } }, "invalid webhook delivery metadata"],
	] satisfies [string, World, string][])("does not mistake %s for verified webhook delivery", async (_, world, message) => {
		const { code, find, output } = await doctor({ world });
		expect(code).toBe(1);
		expect(find("fail", message)).toBeDefined();
		expectNoSecrets(output);
	});

	it("reports a successful delivery as historical evidence without claiming the hook is currently active", async () => {
		const { code, output } = await doctor({
			world: { delivery: { ...DELIVERY, url: "https://gw.onrender.com/webhooks/github", delivered_at: "2026-10-26T00:00:00Z" } },
		});
		expect(code).toBe(0);
		expect(output).toContain("latest delivery to the configured gateway (issues, 2026-10-26T00:00:00Z) got 202");
		expect(output).not.toContain("webhook is active");
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
		});
		expectNoSecrets(output);
	});
});
