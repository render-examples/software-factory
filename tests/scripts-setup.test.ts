import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubApp } from "../scripts/lib/github.js";
import { buildManifest, PLACEHOLDER_WEBHOOK_URL } from "../scripts/lib/manifest.js";
import { Reporter } from "../scripts/lib/output.js";
import { LABELS } from "../scripts/lib/requirements.js";
import { setupGithub } from "../scripts/lib/setup-github.js";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("App manifest", () => {
	const manifest = buildManifest({ name: "sf-test", redirectUrl: "http://127.0.0.1:5555/callback" });

	it("requests exactly the permissions and events the factory uses", () => {
		expect(manifest.default_permissions).toEqual({
			contents: "write",
			issues: "write",
			pull_requests: "write",
			metadata: "read",
		});
		expect([...manifest.default_events].sort()).toEqual(["issue_comment", "issues", "pull_request", "push"]);
		expect(manifest.public).toBe(false);
	});
});

interface Call {
	method: string;
	path: string;
	auth: string;
	body: unknown;
}

type Route = (call: Call) => { status?: number; body?: unknown };

function fakeFetch(routes: Record<string, Route>) {
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
		const route = routes[`${call.method} ${call.path}`];
		const result = route ? route(call) : { status: 404, body: { message: "Not Found" } };
		const status = result.status ?? 200;
		return new Response(status === 204 ? null : JSON.stringify(result.body ?? {}), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const APP = {
	id: 1,
	slug: "sf",
	name: "sf",
	html_url: "https://github.com/apps/sf",
	owner: { login: "acme", type: "Organization" },
	permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
	events: ["issues", "issue_comment", "pull_request", "push"],
};
const TOKEN = "ghs_installationTOKEN123";
const SECRET = "whsec-super-secret-value";

function githubWorld(opts: { labels?: string[]; installed?: boolean; deliveries?: unknown[] } = {}) {
	const labels = new Set(opts.labels ?? []);
	return fakeFetch({
		"GET /app": () => ({ body: APP }),
		"GET /app/hook/config": () => ({
			body: { url: PLACEHOLDER_WEBHOOK_URL, content_type: "form", insecure_ssl: "0", secret: "********" },
		}),
		"PATCH /app/hook/config": (call) => ({ body: { ...(call.body as object), secret: "********" } }),
		"GET /app/hook/deliveries": () => ({ body: opts.deliveries ?? [] }),
		"GET /repos/acme/web/installation": () =>
			opts.installed === false
				? { status: 404, body: { message: "Not Found" } }
				: { body: { id: 7, permissions: APP.permissions, events: APP.events } },
		"POST /app/installations/7/access_tokens": () => ({ status: 201, body: { token: TOKEN } }),
		"GET /repos/acme/web/labels": () => ({ body: [...labels].map((name) => ({ name, color: "000000", description: null })) }),
		"POST /repos/acme/web/labels": (call) => {
			labels.add((call.body as { name: string }).name);
			return { status: 201, body: call.body };
		},
	});
}

function env() {
	return { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString("base64") };
}

describe("setup:github", () => {
	it("PATCHes the webhook config with the App JWT and creates missing labels", async () => {
		const { fetch, calls } = githubWorld({ labels: ["FACTORY:TRIAGE"] });
		const lines: string[] = [];
		const code = await setupGithub(
			new GitHubApp({ env: env(), fetch }),
			{ gatewayUrl: "https://gw.onrender.com", webhookSecret: SECRET, repos: ["acme/web"] },
			new Reporter((line) => lines.push(line)),
		);
		expect(code).toBe(0);

		const patch = calls.find((c) => c.method === "PATCH");
		expect(patch?.path).toBe("/app/hook/config");
		expect(patch?.body).toEqual({
			url: "https://gw.onrender.com/webhooks/github",
			content_type: "json",
			insecure_ssl: "0",
			secret: SECRET,
		});
		expect(patch?.auth.split(".")).toHaveLength(3);

		const created = calls.filter((c) => c.method === "POST" && c.path === "/repos/acme/web/labels");
		expect(created.map((c) => (c.body as { name: string }).name)).toEqual(LABELS.filter((l) => l.name !== "factory:triage").map((l) => l.name));
		expect(created.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);

		const output = lines.join("\n");
		expect(output).toContain("webhook configured; activation and delivery are unverified");
		expect(output).toContain("https://github.com/organizations/acme/settings/apps/sf");
		expect(output).not.toContain(SECRET);
		expect(output).not.toContain(TOKEN);
	});

	it.each([200, 502])("does not present a historical %s attempt as proof after updating the webhook", async (status_code) => {
		const { fetch } = githubWorld({ deliveries: [{ id: 1, event: "ping", status_code, delivered_at: "2020-01-01T00:00:00Z" }] });
		const lines: string[] = [];
		const code = await setupGithub(
			new GitHubApp({ env: env(), fetch }),
			{ gatewayUrl: "https://gw.onrender.com", webhookSecret: SECRET, repos: ["acme/web"] },
			new Reporter((line) => lines.push(line)),
		);
		const output = lines.join("\n");
		expect(code).toBe(0);
		expect(output).toContain("activation and delivery are unverified");
		expect(output).toContain("Webhook > Active");
		expect(output).toContain("Redeliver a ping");
		expect(output).not.toContain("webhook is delivering");
		expect(output).not.toContain(SECRET);
	});

	it("is idempotent: a second run creates no labels", async () => {
		const world = githubWorld();
		const run = () =>
			setupGithub(
				new GitHubApp({ env: env(), fetch: world.fetch }),
				{ gatewayUrl: "https://gw.onrender.com", webhookSecret: SECRET, repos: ["acme/web"] },
				new Reporter(() => {}),
			);
		await run();
		const firstCreates = world.calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels")).length;
		await run();
		const allCreates = world.calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels")).length;
		expect(firstCreates).toBe(LABELS.length);
		expect(allCreates).toBe(firstCreates);
	});
});
