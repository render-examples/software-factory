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
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
				return world.installed === false ? json({ message: "Not Found" }, 404) : json({ id: 7, permissions: APP.permissions, events: APP.events });
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
