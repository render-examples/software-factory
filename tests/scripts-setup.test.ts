import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertEnv } from "../scripts/lib/env-file.js";
import { GitHubApp, githubWebUrl } from "../scripts/lib/github.js";
import {
	buildManifest,
	type CallbackServer,
	escapeHtml,
	formPage,
	type ManifestConversion,
	PLACEHOLDER_WEBHOOK_URL,
	registrationUrl,
	startCallbackServer,
	successPage,
} from "../scripts/lib/manifest.js";
import { Reporter } from "../scripts/lib/output.js";
import { LABELS, SERVICE_ENV } from "../scripts/lib/requirements.js";
import { appSettingsUrl, setupGithub, webhookUrl } from "../scripts/lib/setup-github.js";

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

	it("starts with an inactive webhook at a placeholder URL", () => {
		expect(manifest.hook_attributes).toEqual({ url: PLACEHOLDER_WEBHOOK_URL, active: false });
		expect(manifest.redirect_url).toBe("http://127.0.0.1:5555/callback");
	});

	it("posts to the user's or organization's new-App page with state", () => {
		expect(registrationUrl("https://github.com", "abc", undefined)).toBe("https://github.com/settings/apps/new?state=abc");
		expect(registrationUrl("https://github.com", "abc", "acme")).toBe(
			"https://github.com/organizations/acme/settings/apps/new?state=abc",
		);
		expect(githubWebUrl("https://api.github.com")).toBe("https://github.com");
		expect(githubWebUrl("https://ghe.example.com/api/v3")).toBe("https://ghe.example.com");
	});
});

describe("HTML escaping", () => {
	const evil = `"><script>alert('x')</script>&`;

	it("escapes every special character", () => {
		expect(escapeHtml(evil)).toBe("&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;");
	});

	it("escapes the App name, repos, action, and manifest in the form page", () => {
		const manifest = buildManifest({ name: evil, redirectUrl: "http://127.0.0.1:1/callback" });
		const html = formPage(manifest, `https://github.com/x?state="${evil}`, [evil]);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain(`value='`);
		const value = /name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "";
		const decoded = value
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");
		expect(JSON.parse(decoded)).toEqual(manifest);
	});

	it("escapes the slug and URL on the success page", () => {
		const html = successPage({ id: 1, slug: evil, name: evil, pem: "", html_url: `https://github.com/apps/${evil}` });
		expect(html).not.toContain("<script>");
	});
});

describe("manifest callback server", () => {
	let server: CallbackServer | undefined;
	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	const app: ManifestConversion = { id: 42, slug: "sf-test", name: "sf-test", pem: "PEM", html_url: "https://github.com/apps/sf-test" };

	it("binds 127.0.0.1 and serves the form with the redirect URL", async () => {
		server = await startCallbackServer({
			state: "s".repeat(64),
			form: (redirect) => `<p>${redirect}</p>`,
			exchange: async () => app,
		});
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		const html = await (await fetch(`${server.url}/`)).text();
		expect(html).toContain(`${server.url}/callback`);
	});

	it("rejects a callback with a missing or wrong state without exchanging the code", async () => {
		const exchange = vi.fn(async () => app);
		server = await startCallbackServer({ state: "a".repeat(64), form: () => "", exchange });
		expect((await fetch(`${server.url}/callback?code=abc`)).status).toBe(400);
		expect((await fetch(`${server.url}/callback?code=abc&state=${"b".repeat(64)}`)).status).toBe(400);
		expect((await fetch(`${server.url}/callback?code=abc&state=short`)).status).toBe(400);
		expect(exchange).not.toHaveBeenCalled();
	});

	it("exchanges the code once on a matching state and resolves with the App", async () => {
		const state = "c".repeat(64);
		const exchange = vi.fn(async () => app);
		server = await startCallbackServer({ state, form: () => "", exchange });
		const response = await fetch(`${server.url}/callback?code=abc123&state=${state}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("sf-test");
		await expect(server.result).resolves.toEqual(app);
		expect(exchange).toHaveBeenCalledWith("abc123");
		expect((await fetch(`${server.url}/callback?code=again&state=${state}`)).status).toBe(410);
		expect(exchange).toHaveBeenCalledTimes(1);
	});
});

describe("upsertEnv", () => {
	it("replaces existing keys, appends new ones, and keeps everything else", () => {
		const before = "# comment\nGITHUB_APP_ID=\nPORT=3000\n";
		expect(upsertEnv(before, { GITHUB_APP_ID: "7", GITHUB_WEBHOOK_SECRET: "s" })).toBe(
			"# comment\nGITHUB_APP_ID=7\nPORT=3000\nGITHUB_WEBHOOK_SECRET=s\n",
		);
		expect(upsertEnv("", { A: "1" })).toBe("A=1\n");
	});

	it("refuses multi-line values", () => {
		expect(() => upsertEnv("", { KEY: "a\nb" })).toThrow(/single line/);
	});
});

describe("render.yaml", () => {
	it("declares exactly the env vars doctor checks for each service", () => {
		const yaml = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
		const keysFor = (service: string) => {
			const start = yaml.indexOf(`\n    name: ${service}\n`);
			expect(start).toBeGreaterThan(0);
			const next = yaml.indexOf("\n  - type:", start);
			const block = yaml.slice(start, next === -1 ? undefined : next);
			return [...block.matchAll(/- key: (\w+)/g)].map((m) => m[1]);
		};
		expect(keysFor("factory-gateway")).toEqual([...SERVICE_ENV.gateway]);
		expect(keysFor("factory-workflows")).toEqual([...SERVICE_ENV.workflows]);
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
			opts.installed === false ? { status: 404, body: { message: "Not Found" } } : { body: { id: 7, permissions: APP.permissions, events: APP.events } },
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
	it("normalizes the gateway URL to its /webhooks/github path and requires https", () => {
		expect(webhookUrl("https://gw.onrender.com")).toBe("https://gw.onrender.com/webhooks/github");
		expect(webhookUrl("https://gw.onrender.com/")).toBe("https://gw.onrender.com/webhooks/github");
		expect(webhookUrl("https://gw.onrender.com/webhooks/github/")).toBe("https://gw.onrender.com/webhooks/github");
		expect(() => webhookUrl("http://gw.onrender.com")).toThrow(/https/);
		expect(() => webhookUrl("not a url")).toThrow(/not a URL/);
	});

	it("links to the org or user App settings page", () => {
		expect(appSettingsUrl(APP, "https://api.github.com")).toBe("https://github.com/organizations/acme/settings/apps/sf");
		expect(appSettingsUrl({ ...APP, owner: { login: "me", type: "User" } }, "https://api.github.com")).toBe(
			"https://github.com/settings/apps/sf",
		);
	});

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
		expect(created.map((c) => (c.body as { name: string }).name)).toEqual(
			LABELS.filter((l) => l.name !== "factory:triage").map((l) => l.name),
		);
		expect(created.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);

		const output = lines.join("\n");
		expect(output).toContain("webhook activation can't be set through the API");
		expect(output).toContain("https://github.com/organizations/acme/settings/apps/sf");
		expect(output).not.toContain(SECRET);
		expect(output).not.toContain(TOKEN);
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

	it("skips the manual activation step once deliveries arrive", async () => {
		const { fetch } = githubWorld({
			deliveries: [{ id: 1, delivered_at: "2026-10-18T00:00:00Z", status_code: 202, event: "issues" }],
		});
		const lines: string[] = [];
		await setupGithub(
			new GitHubApp({ env: env(), fetch }),
			{ gatewayUrl: "https://gw.onrender.com", webhookSecret: SECRET, repos: [] },
			new Reporter((line) => lines.push(line)),
		);
		expect(lines.join("\n")).toContain("webhook is delivering");
		expect(lines.join("\n")).not.toContain("turn it on by hand");
	});

	it("fails, with the install link, for a repo without an installation", async () => {
		const { fetch, calls } = githubWorld({ installed: false });
		const lines: string[] = [];
		const code = await setupGithub(
			new GitHubApp({ env: env(), fetch }),
			{ gatewayUrl: "https://gw.onrender.com", webhookSecret: SECRET, repos: ["acme/web"] },
			new Reporter((line) => lines.push(line)),
		);
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("https://github.com/apps/sf/installations/new");
		expect(calls.some((c) => c.path.endsWith("/labels"))).toBe(false);
	});
});
