import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubApp } from "../scripts/lib/github.js";
import { buildManifest, PLACEHOLDER_WEBHOOK_URL } from "../scripts/lib/manifest.js";
import { Reporter } from "../scripts/lib/output.js";
import { LABELS } from "../scripts/lib/requirements.js";
import { setupGithub } from "../scripts/lib/setup-github.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

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

function githubWorld(opts: { labels?: string[]; deliveries?: unknown[] } = {}) {
	const labels = new Set(opts.labels ?? []);
	return fakeFetch({
		"GET /app": APP,
		"GET /app/hook/config": { url: PLACEHOLDER_WEBHOOK_URL, content_type: "form", insecure_ssl: "0", secret: "********" },
		"PATCH /app/hook/config": ({ body }) => ({ ...(body as object), secret: "********" }),
		"GET /app/hook/deliveries": opts.deliveries ?? [],
		"GET /repos/acme/web/installation": { id: 7, permissions: APP.permissions, events: APP.events },
		"POST /app/installations/7/access_tokens": json({ token: TOKEN }, 201),
		"GET /repos/acme/web/labels": () => [...labels].map((name) => ({ name, color: "000000", description: null })),
		"POST /repos/acme/web/labels": ({ body }) => {
			labels.add((body as { name: string }).name);
			return json(body, 201);
		},
	});
}

async function run(world: ReturnType<typeof githubWorld>) {
	const lines: string[] = [];
	const code = await setupGithub(
		new GitHubApp({ env: { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString("base64") }, fetch: world.fetch }),
		{ gatewayUrl: "https://gw.onrender.com", webhookSecret: SECRET, repos: ["acme/web"] },
		new Reporter((line) => lines.push(line)),
	);
	return { code, output: lines.join("\n") };
}

const labelCreates = (world: ReturnType<typeof githubWorld>) =>
	world.requests.filter((r) => r.method === "POST" && r.url.pathname === "/repos/acme/web/labels");

describe("setup:github", () => {
	it("PATCHes the webhook config with the App JWT and creates missing labels", async () => {
		const world = githubWorld({ labels: ["FACTORY:TRIAGE"] });
		const { code, output } = await run(world);
		expect(code).toBe(0);

		const patch = world.requests.find((r) => r.method === "PATCH");
		expect(patch?.url.pathname).toBe("/app/hook/config");
		expect(patch?.body).toEqual({
			url: "https://gw.onrender.com/webhooks/github",
			content_type: "json",
			insecure_ssl: "0",
			secret: SECRET,
		});
		expect(patch?.headers.get("Authorization")).toMatch(/^Bearer \S+\.\S+\.\S+$/);

		const created = labelCreates(world);
		expect(created.map((r) => (r.body as { name: string }).name)).toEqual(LABELS.filter((l) => l.name !== "factory:triage").map((l) => l.name));
		expect(created.every((r) => r.headers.get("Authorization") === `Bearer ${TOKEN}`)).toBe(true);

		expect(output).toContain("webhook configured; activation and delivery are unverified");
		expect(output).toContain("https://github.com/organizations/acme/settings/apps/sf");
		expect(output).not.toContain(SECRET);
		expect(output).not.toContain(TOKEN);
	});

	it.each([200, 502])("does not present a historical %s attempt as proof after updating the webhook", async (status_code) => {
		const { code, output } = await run(githubWorld({ deliveries: [{ id: 1, event: "ping", status_code, delivered_at: "2020-01-01T00:00:00Z" }] }));
		expect(code).toBe(0);
		expect(output).toContain("activation and delivery are unverified");
		expect(output).toContain("Webhook > Active");
		expect(output).toContain("Redeliver a ping");
		expect(output).not.toContain("webhook is delivering");
		expect(output).not.toContain(SECRET);
	});

	it("is idempotent: a second run creates no labels", async () => {
		const world = githubWorld();
		await run(world);
		expect(labelCreates(world)).toHaveLength(LABELS.length);
		await run(world);
		expect(labelCreates(world)).toHaveLength(LABELS.length);
	});
});
