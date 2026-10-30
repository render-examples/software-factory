import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Reporter } from "../scripts/lib/output.js";
import { type PreflightOptions, runPreflight, setupRenderWithPreflight } from "../scripts/lib/preflight.js";

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
	GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
	ANTHROPIC_API_KEY: "sk-ant-preflight-model-key",
};
const ENV = { ...SECRETS, GITHUB_APP_ID: "1", RENDER_WORKSPACE_ID: WORKSPACE };

interface Call {
	method: string;
	url: URL;
	auth: string;
	body: unknown;
}

interface WorldOptions {
	metadata?: unknown;
	metadataStatus?: number;
	branch?: unknown;
	branchStatus?: number;
	installationStatus?: number;
	workspace?: unknown;
	workspaceStatus?: number;
	workspaceInvalidJson?: boolean;
	metadataThrows?: boolean;
}

function world(opts: WorldOptions = {}) {
	const calls: Call[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const call: Call = {
			method: init?.method ?? "GET",
			url,
			auth: new Headers(init?.headers).get("Authorization") ?? "",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		calls.push(call);
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url.host === "api.render.com" && url.pathname === `/v1/owners/${WORKSPACE}`) {
			if (opts.workspaceInvalidJson) return new Response("not json", { status: 200 });
			return json("workspace" in opts ? opts.workspace : { id: WORKSPACE, name: "Acme" }, opts.workspaceStatus);
		}
		if (url.host === "api.render.com" && url.pathname === "/v1/env-groups") {
			return call.method === "GET" ? json([]) : json({ id: "evg-created", ...(call.body as object) }, 201);
		}
		if (url.host === "api.github.com") {
			if (url.pathname === `/repos/${REPO}/installation`) return json({ id: 7 }, opts.installationStatus);
			if (url.pathname === "/app/installations/7/access_tokens") return json({ token: TOKEN }, 201);
			if (url.pathname === `/repos/${REPO}`) {
				if (opts.metadataThrows) throw new Error(`Network error containing ${TOKEN} and ${SECRETS.RENDER_API_KEY}`);
				return json("metadata" in opts ? opts.metadata : { full_name: REPO, has_issues: true, archived: false }, opts.metadataStatus);
			}
			if (url.pathname === `/repos/${REPO}/branches/${encodeURIComponent(BRANCH)}`) {
				return json("branch" in opts ? opts.branch : { name: BRANCH, commit: { sha: "a".repeat(40) } }, opts.branchStatus);
			}
		}
		return json({ message: "Unexpected endpoint" }, 404);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

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
	return { code, output: lines.join("\n"), results: out.results };
}

const envGroupRequests = (api: ReturnType<typeof world>) => api.calls.filter((call) => call.url.pathname.startsWith("/v1/env-groups"));

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
		expect(api.calls.filter((call) => call.method !== "GET")).toEqual([
			expect.objectContaining({
				method: "POST",
				body: { repositories: ["widget"], permissions: { contents: "read", metadata: "read" } },
			}),
		]);
		const repositoryReads = api.calls.filter((call) => call.url.pathname === `/repos/${REPO}` || call.url.pathname.includes("/branches/"));
		expect(repositoryReads).toHaveLength(2);
		expect(repositoryReads.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
		expectNoSecrets(output);
	});

	it("allows environment-group creation only after repository and workspace checks pass", async () => {
		const api = world();
		const { code, output } = await run(api);
		expect(code).toBe(0);
		expect(envGroupRequests(api).filter((call) => call.method === "POST")).toHaveLength(3);
		const checkedBranch = api.calls.findIndex((call) => call.url.pathname.includes("/branches/"));
		const firstGroupRequest = api.calls.findIndex((call) => call.url.pathname === "/v1/env-groups");
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
		expect(api.calls).toEqual([]);
	});

	it.each([
		{ name: "Issues disabled", metadata: { full_name: REPO, has_issues: false, archived: false }, message: "Issues is disabled" },
		{ name: "archived repository", metadata: { full_name: REPO, has_issues: true, archived: true }, message: "repository is archived" },
		{ name: "null metadata", metadata: null, message: "repository metadata is invalid" },
		{ name: "missing capability fields", metadata: { full_name: REPO }, message: "repository metadata is invalid" },
		{
			name: "another repository's metadata",
			metadata: { full_name: "other/repo", has_issues: true, archived: false },
			message: "repository metadata is invalid",
		},
	])("blocks environment-group setup for $name", async ({ metadata, message }) => {
		const api = world({ metadata });
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain(message);
		expect(envGroupRequests(api)).toEqual([]);
		expectNoSecrets(output);
	});

	it.each([403, 404])("blocks environment-group setup when repository metadata is inaccessible (HTTP %i)", async (metadataStatus) => {
		const api = world({ metadataStatus });
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain("repository capabilities could not be verified");
		expect(envGroupRequests(api)).toEqual([]);
	});

	it.each([403, 404])("blocks environment-group setup for a missing or inaccessible base branch (HTTP %i)", async (branchStatus) => {
		const api = world({ branchStatus });
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain(`base branch ${BRANCH} is missing or inaccessible`);
		expect(envGroupRequests(api)).toEqual([]);
	});

	it.each([
		{ name: "null branch", branch: null },
		{ name: "wrong branch", branch: { name: "main", commit: { sha: "a".repeat(40) } } },
		{ name: "invalid commit", branch: { name: BRANCH, commit: { sha: "not-a-sha" } } },
	])("blocks environment-group setup when branch metadata is invalid: $name", async ({ branch }) => {
		const api = world({ branch });
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain(`base branch ${BRANCH} could not be verified`);
		expect(envGroupRequests(api)).toEqual([]);
	});

	it.each([401, 403])("blocks environment-group setup when the Render key is rejected (HTTP %i)", async (workspaceStatus) => {
		const api = world({ workspaceStatus });
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain("RENDER_API_KEY was rejected");
		expect(envGroupRequests(api)).toEqual([]);
	});

	it.each([
		{ name: "invalid JSON", workspaceInvalidJson: true },
		{ name: "null metadata", workspace: null },
		{ name: "another workspace", workspace: { id: "tea-other", name: "Other" } },
	])("blocks environment-group setup when workspace access cannot be verified: $name", async (opts) => {
		const api = world(opts);
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain("Render workspace metadata is invalid");
		expect(envGroupRequests(api)).toEqual([]);
	});

	it("blocks setup and explains when the App is not installed on the target repository", async () => {
		const api = world({ installationStatus: 404 });
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain(`${REPO}: GitHub App is not installed`);
		expect(api.calls.some((call) => call.method === "POST")).toBe(false);
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

	it.each(Object.keys(ENV))("blocks setup before any API request when %s is missing", async (key) => {
		const api = world();
		const { code, output } = await run(api, { env: { ...ENV, [key]: " " } });
		expect(code).toBe(1);
		expect(output).toContain(`${key} is not set`);
		expect(api.calls).toEqual([]);
		expectNoSecrets(output);
	});

	it("blocks setup for an unsupported Node version before any API request", async () => {
		const api = world();
		const { code, output } = await run(api, { nodeVersion: "22.19.0" });
		expect(code).toBe(1);
		expect(output).toContain("Node 24 is required");
		expect(api.calls).toEqual([]);
	});

	it.each(["", "  "])("blocks setup for an empty configured base branch (%j) before any API request", async (baseBranch) => {
		const api = world();
		const { code, output } = await run(api, { repos: { [REPO]: { baseBranch, verify: [] } } });
		expect(code).toBe(1);
		expect(output).toContain(`${REPO}: baseBranch is empty`);
		expect(api.calls).toEqual([]);
	});

	it("rejects an empty target list and malformed workspace identifier before any API request", async () => {
		const api = world();
		const { code, output } = await run(api, { repos: {}, env: { ...ENV, RENDER_WORKSPACE_ID: "srv-not-a-workspace" } });
		expect(code).toBe(1);
		expect(output).toContain("No target repositories configured");
		expect(output).toContain("RENDER_WORKSPACE_ID is not a workspace ID");
		expect(api.calls).toEqual([]);
	});

	it("does not expose credentials or a minted installation token when GitHub fails", async () => {
		const api = world({ metadataThrows: true });
		const { code, output } = await run(api);
		expect(code).toBe(1);
		expect(output).toContain("repository capabilities could not be verified");
		expect(envGroupRequests(api)).toEqual([]);
		expectNoSecrets(output);
	});
});
