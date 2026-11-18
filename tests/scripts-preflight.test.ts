import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Reporter } from "../scripts/lib/output.js";
import { type PreflightOptions, runPreflight, setupRenderWithPreflight } from "../scripts/lib/preflight.js";
import { pgliteDb } from "./helpers/db.js";
import { fakeFetch, json, type Routes } from "./helpers/fake-fetch.js";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const WORKSPACE = "tea-abc123";
const REPO = "acme/widget";
const BRANCH = "release/candidate";
const TOKEN = "ghs_readonly_preflight_token";
const SECRETS = {
	RENDER_API_KEY: "rnd_preflight_render_key",
	GITHUB_WEBHOOK_SECRET: "preflight_webhook_secret",
	EVENTS_READ_TOKEN: "preflight_events_token",
	GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
	ANTHROPIC_API_KEY: "sk-ant-preflight-model-key",
};
const ENV = { ...SECRETS, GITHUB_APP_ID: "1", RENDER_WORKSPACE_ID: WORKSPACE };

const OWNER = `GET /v1/owners/${WORKSPACE}`;
const INSTALLATION = `GET /repos/${REPO}/installation`;
const METADATA = `GET /repos/${REPO}`;
const BRANCH_ROUTE = `GET /repos/${REPO}/branches/${encodeURIComponent(BRANCH)}`;

const world = (routes: Routes = {}) =>
	fakeFetch({
		[OWNER]: { id: WORKSPACE, name: "Acme" },
		"GET /v1/env-groups": [],
		"POST /v1/env-groups": ({ body }) => json({ id: "evg-created", ...(body as object) }, 201),
		[INSTALLATION]: { id: 7 },
		"POST /app/installations/7/access_tokens": json({ token: TOKEN }, 201),
		[METADATA]: { full_name: REPO, has_issues: true, archived: false },
		[BRANCH_ROUTE]: { name: BRANCH, commit: { sha: "a".repeat(40) } },
		...routes,
	});

async function run(api: ReturnType<typeof world>, overrides: Partial<PreflightOptions> = {}, combined = true) {
	const lines: string[] = [];
	const out = new Reporter((line) => lines.push(line));
	const opts: PreflightOptions = {
		env: ENV,
		repos: { [REPO]: { baseBranch: BRANCH, verify: [] } },
		nodeVersion: "24.18.0",
		requiredNodeMajor: 24,
		fetch: api.fetch,
		sleep: async () => {},
		...overrides,
	};
	const code = await (combined ? setupRenderWithPreflight(opts, out) : runPreflight(opts, out));
	return { code, output: lines.join("\n") };
}

const envGroupRequests = (api: ReturnType<typeof world>) => api.requests.filter((r) => r.url.pathname.startsWith("/v1/env-groups"));

function expectNoSecrets(output: string): void {
	for (const secret of [...Object.values(SECRETS), privateKey, TOKEN]) expect(output).not.toContain(secret);
}

describe("deployment preflight", () => {
	it("verifies Issues, a non-main branch with a slash, and workspace access without changing infrastructure", async () => {
		const api = world();
		const { code, output } = await run(api, {}, false);
		expect(code).toBe(0);
		expect(output).toContain(`${REPO}: Issues is enabled`);
		expect(output).toContain(`${REPO}: base branch ${BRANCH} is accessible`);
		expect(output).toContain(`Acme (${WORKSPACE})`);
		expect(output).toContain("Model and Sandbox execution remain unverified");
		expect(output).toContain("Key presence does not verify model access or provider spend caps");
		expect(envGroupRequests(api)).toEqual([]);
		const repositoryReads = api.requests.filter((r) => r.url.pathname === `/repos/${REPO}` || r.url.pathname.includes("/branches/"));
		expect(repositoryReads).toHaveLength(2);
		expect(repositoryReads.every((r) => r.headers.get("Authorization") === `Bearer ${TOKEN}`)).toBe(true);
		expectNoSecrets(output);
	});

	it("allows environment-group creation only after repository and workspace checks pass", async () => {
		const api = world();
		const { code, output } = await run(api);
		expect(code).toBe(0);
		expect(envGroupRequests(api).filter((r) => r.method === "POST")).toHaveLength(3);
		const checkedBranch = api.requests.findIndex((r) => r.url.pathname.includes("/branches/"));
		const firstGroupRequest = api.requests.findIndex((r) => r.url.pathname === "/v1/env-groups");
		expect(checkedBranch).toBeGreaterThan(-1);
		expect(firstGroupRequest).toBeGreaterThan(checkedBranch);
		expectNoSecrets(output);
	});

	it("checks local prerequisites without credentials or API requests", async () => {
		const api = world();
		const { code, output } = await run(api, { local: true, env: {}, repos: {} }, false);
		expect(code).toBe(0);
		expect(output).toContain("Node 24 matches .node-version");
		expect(output).not.toContain("is not set");
		expect(api.requests).toEqual([]);
	});

	it("checks a local DATABASE_URL when one is set", async () => {
		const { db } = await pgliteDb();
		const env = { DATABASE_URL: "postgresql://localhost/factory" };
		const { code, output } = await run(world(), { local: true, env, repos: {}, openDb: () => db }, false);
		expect(code).toBe(0);
		expect(output).toContain("DATABASE_URL connects");
		expect(output).toContain("migrations are current");
	});

	it.each([
		["Issues disabled", { [METADATA]: { full_name: REPO, has_issues: false, archived: false } }, "Issues is disabled"],
		["an archived repository", { [METADATA]: { full_name: REPO, has_issues: true, archived: true } }, "repository is archived"],
		[
			"another repository's metadata",
			{ [METADATA]: { full_name: "other/repo", has_issues: true, archived: false } },
			"repository metadata is invalid",
		],
		["inaccessible repository metadata", { [METADATA]: json({ message: "Forbidden" }, 403) }, "repository capabilities could not be verified"],
		[
			"a GitHub failure that echoes credentials and the minted token",
			{ [METADATA]: new Error(`Network error containing ${TOKEN} and ${SECRETS.RENDER_API_KEY}`) },
			"repository capabilities could not be verified",
		],
		[
			"a missing or inaccessible base branch",
			{ [BRANCH_ROUTE]: json({ message: "Forbidden" }, 403) },
			`base branch ${BRANCH} is missing or inaccessible`,
		],
		["invalid branch metadata", { [BRANCH_ROUTE]: { name: "main", commit: { sha: "a".repeat(40) } } }, `base branch ${BRANCH} could not be verified`],
		["a rejected Render key", { [OWNER]: json({ message: "nope" }, 401) }, "RENDER_API_KEY was rejected"],
		["another workspace's metadata", { [OWNER]: { id: "tea-other", name: "Other" } }, "Render workspace metadata is invalid"],
	] satisfies [string, Routes, string][])("blocks environment-group setup for %s", async (_, routes, message) => {
		const api = world(routes);
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain(message);
		expect(envGroupRequests(api)).toEqual([]);
		expectNoSecrets(output);
	});

	it("blocks setup and explains when the App is not installed on the target repository", async () => {
		const api = world({ [INSTALLATION]: json({ message: "Not Found" }, 404) });
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain(`${REPO}: GitHub App is not installed`);
		expect(api.requests.some((r) => r.method === "POST")).toBe(false);
		expect(envGroupRequests(api)).toEqual([]);
	});

	it("checks every configured repository before writing any environment groups", async () => {
		const api = world();
		const { code, output } = await run(api, {
			repos: { [REPO]: { baseBranch: BRANCH, verify: [] }, "other/uninstalled": { baseBranch: "main", verify: [] } },
		});
		expect(code).toBe(1);
		expect(output).toContain(`${REPO}: base branch ${BRANCH} is accessible`);
		expect(output).toContain("other/uninstalled: GitHub App is not installed");
		expect(envGroupRequests(api)).toEqual([]);
	});

	it.each([
		["a missing RENDER_API_KEY", { env: { ...ENV, RENDER_API_KEY: " " } }, ["RENDER_API_KEY is not set"]],
		["a missing ANTHROPIC_API_KEY", { env: { ...ENV, ANTHROPIC_API_KEY: " " } }, ["ANTHROPIC_API_KEY is not set"]],
		["an unsupported Node version", { nodeVersion: "22.19.0" }, ["Node 24 is required"]],
		["an empty configured base branch", { repos: { [REPO]: { baseBranch: "  ", verify: [] } } }, [`${REPO}: baseBranch is empty`]],
		[
			"an empty target list and malformed workspace identifier",
			{ repos: {}, env: { ...ENV, RENDER_WORKSPACE_ID: "srv-not-a-workspace" } },
			["No target repositories configured", "RENDER_WORKSPACE_ID is not a workspace ID"],
		],
	] satisfies [string, Partial<PreflightOptions>, string[]][])("blocks setup before any API request for %s", async (_, overrides, messages) => {
		const api = world();
		const { code, output } = await run(api, overrides);
		expect(code).toBe(1);
		for (const message of messages) expect(output).toContain(message);
		expect(api.requests).toEqual([]);
		expectNoSecrets(output);
	});
});
