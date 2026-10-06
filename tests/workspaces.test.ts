import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExecResult } from "../app/sandbox/types.js";

/* ── Fake Sandbox ───────────────────────────────────────────────── */

interface ScriptedResponse {
	match: string;
	result: ExecResult;
}

function createFakeSandbox(responses: ScriptedResponse[]) {
	const queue = [...responses];
	const uploadedFiles: Array<{ path: string; data: string }> = [];
	const terminated = { value: false };

	function findResponse(command: string): ExecResult {
		const idx = queue.findIndex((r) => command.includes(r.match));
		if (idx >= 0) {
			const [matched] = queue.splice(idx, 1);
			return matched.result;
		}
		return { output: "", exitCode: 0 };
	}

	return {
		id: "sbx-fake-1",
		terminated,
		uploadedFiles,
		run: vi.fn(async (command: string): Promise<ExecResult> => {
			return findResponse(command);
		}),
		mustRun: vi.fn(async (command: string, label: string): Promise<string> => {
			const result = findResponse(command);
			if (result.exitCode !== 0) {
				throw new Error(
					`${label} failed (exit ${result.exitCode}): ${result.output.slice(0, 500)}`,
				);
			}
			return result.output;
		}),
		upload: vi.fn(async (path: string, data: unknown) => {
			uploadedFiles.push({
				path,
				data: typeof data === "string" ? data : "",
			});
		}),
		terminate: vi.fn(async () => {
			terminated.value = true;
		}),
		exec: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		listDir: vi.fn(),
		download: vi.fn(),
	};
}

const FAKE_HASH =
	"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

/* ── Credential tests ───────────────────────────────────────────── */

vi.mock("../app/github/index.js", () => ({
	githubToken: vi.fn(async () => "ghs_test_token_12345"),
	resetTokenCache: vi.fn(),
	GitHub: vi.fn(),
	githubFromEnv: vi.fn(),
	GitHubHttp: vi.fn(),
	GitHubError: vi.fn(),
}));

vi.mock("../app/sandbox/client.js", () => ({
	api: () => ({
		client: {
			exec: vi.fn(),
			upload: vi.fn(),
			download: vi.fn(),
			terminate: vi.fn(),
			create: vi.fn(),
			get: vi.fn(),
		},
		ownerId: "tea-test" as const,
	}),
}));

describe("credentials", () => {
	describe("cloneWithReadToken", () => {
		it("never includes the token in git command lines", async () => {
			const sandbox = createFakeSandbox([
				{
					match: "clone",
					result: { output: "Cloning...", exitCode: 0 },
				},
				{
					match: ".git/config",
					result: {
						output: `[remote "origin"]\n\turl = https://github.com/test-owner/test-repo.git\n`,
						exitCode: 0,
					},
				},
				{
					match: "remote get-url",
					result: {
						output: "https://github.com/test-owner/test-repo.git\n",
						exitCode: 0,
					},
				},
			]);

			const { cloneWithReadToken } = await import(
				"../app/workspaces/credentials.js"
			);

			await cloneWithReadToken(
				sandbox as never,
				{ owner: "test-owner", repo: "test-repo", branch: "main" },
				"/home/user/repo",
			);

			for (const call of sandbox.run.mock.calls) {
				expect(call[0]).not.toContain("ghs_test_token_12345");
			}
			for (const call of sandbox.mustRun.mock.calls) {
				expect(call[0]).not.toContain("ghs_test_token_12345");
			}
		});

		it("delivers the token through GIT_ASKPASS", async () => {
			const sandbox = createFakeSandbox([
				{
					match: "clone",
					result: { output: "Cloning...", exitCode: 0 },
				},
				{
					match: ".git/config",
					result: {
						output: `[remote "origin"]\n\turl = https://github.com/test-owner/test-repo.git\n`,
						exitCode: 0,
					},
				},
				{
					match: "remote get-url",
					result: {
						output: "https://github.com/test-owner/test-repo.git\n",
						exitCode: 0,
					},
				},
			]);

			const { cloneWithReadToken } = await import(
				"../app/workspaces/credentials.js"
			);
			await cloneWithReadToken(
				sandbox as never,
				{ owner: "test-owner", repo: "test-repo" },
				"/home/user/repo",
			);

			const askpassUpload = sandbox.uploadedFiles.find((f) =>
				f.path.startsWith("/tmp/render-factory-askpass-"),
			);
			expect(askpassUpload).toBeDefined();
			expect(askpassUpload?.data).toContain("ghs_test_token_12345");

			const cloneCall = sandbox.run.mock.calls.find((c: [string]) =>
				c[0].includes("GIT_ASKPASS"),
			);
			expect(cloneCall).toBeDefined();
		});

		it("removes the askpass script even on clone failure", async () => {
			const sandbox = createFakeSandbox([
				{
					match: "clone",
					result: { output: "fatal: repo not found", exitCode: 128 },
				},
			]);

			const { cloneWithReadToken } = await import(
				"../app/workspaces/credentials.js"
			);

			await expect(
				cloneWithReadToken(
					sandbox as never,
					{ owner: "test-owner", repo: "test-repo" },
					"/home/user/repo",
				),
			).rejects.toThrow("Clone failed");

			const rmCall = sandbox.run.mock.calls.find((c: [string]) =>
				c[0].includes("rm -f"),
			);
			expect(rmCall).toBeDefined();
		});

		it("fails closed when .git/config contains a credential", async () => {
			const sandbox = createFakeSandbox([
				{
					match: "clone",
					result: { output: "Cloning...", exitCode: 0 },
				},
				{
					match: ".git/config",
					result: {
						output: `[remote "origin"]\n\turl = https://x-access-token:ghs_leaked@github.com/a/b.git\n`,
						exitCode: 0,
					},
				},
			]);

			const { cloneWithReadToken } = await import(
				"../app/workspaces/credentials.js"
			);

			await expect(
				cloneWithReadToken(
					sandbox as never,
					{ owner: "test-owner", repo: "test-repo" },
					"/home/user/repo",
				),
			).rejects.toThrow("Credential leak detected");
		});

		it("fails when remote URL does not match expected", async () => {
			const sandbox = createFakeSandbox([
				{
					match: "clone",
					result: { output: "Cloning...", exitCode: 0 },
				},
				{
					match: ".git/config",
					result: {
						output: `[remote "origin"]\n\turl = https://github.com/test-owner/test-repo.git\n`,
						exitCode: 0,
					},
				},
				{
					match: "remote get-url",
					result: {
						output: "https://github.com/evil/other-repo.git\n",
						exitCode: 0,
					},
				},
			]);

			const { cloneWithReadToken } = await import(
				"../app/workspaces/credentials.js"
			);

			await expect(
				cloneWithReadToken(
					sandbox as never,
					{ owner: "test-owner", repo: "test-repo" },
					"/home/user/repo",
				),
			).rejects.toThrow("Remote URL mismatch");
		});
	});

	describe("fetchWithReadToken", () => {
		it("removes the askpass script even on fetch failure", async () => {
			const sandbox = createFakeSandbox([
				{
					match: "fetch",
					result: { output: "fatal: could not read", exitCode: 128 },
				},
			]);

			const { fetchWithReadToken } = await import(
				"../app/workspaces/credentials.js"
			);

			await expect(
				fetchWithReadToken(sandbox as never, "/home/user/repo", "main", {
					owner: "test-owner",
					repo: "test-repo",
				}),
			).rejects.toThrow("Fetch failed");

			const rmCall = sandbox.run.mock.calls.find((c: [string]) =>
				c[0].includes("rm -f"),
			);
			expect(rmCall).toBeDefined();
		});
	});
});

/* ── Lockfile hash tests ────────────────────────────────────────── */

describe("lockfileHashInSandbox", () => {
	it("uses sha256sum inside the sandbox", async () => {
		const sandbox = createFakeSandbox([
			{
				match: "sha256sum",
				result: {
					output: `${FAKE_HASH}  /home/user/repo/package-lock.json\n`,
					exitCode: 0,
				},
			},
		]);

		const { lockfileHashInSandbox } = await import("../app/workspaces/hash.js");
		const hash = await lockfileHashInSandbox(
			sandbox as never,
			"/home/user/repo",
		);
		expect(hash).toBe(FAKE_HASH);
	});

	it("returns empty-file hash when no lockfile exists", async () => {
		const sandbox = createFakeSandbox([]);

		const { lockfileHashInSandbox } = await import("../app/workspaces/hash.js");
		const hash = await lockfileHashInSandbox(
			sandbox as never,
			"/home/user/repo",
		);
		expect(hash).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});
});

/* ── openWorkspace tests ────────────────────────────────────────── */

function mockConfig() {
	vi.doMock("../app/config/index.js", () => ({
		target: () => ({
			owner: "jacobprall",
			name: "render-factory-sample",
			baseBranch: "main",
			repoDir: "/home/user/repo",
			setup: { install: "npm ci" },
			verify: [],
		}),
		repository: () => ({
			owner: "jacobprall",
			repo: "render-factory-sample",
			fullName: "jacobprall/render-factory-sample",
		}),
	}));
}

function mockStore(overrides: Record<string, unknown> = {}) {
	vi.doMock("../app/store/index.js", () => ({
		listSandboxesForRun: vi.fn().mockResolvedValue([]),
		markSandboxTerminated: vi.fn(),
		markSandboxFailed: vi.fn(),
		recordSandbox: vi.fn(),
		setSandboxProviderId: vi.fn(),
		markSandboxPreparing: vi.fn().mockResolvedValue(true),
		markSandboxReady: vi.fn().mockResolvedValue(true),
		currentSnapshot: vi.fn().mockResolvedValue(null),
		recordSnapshot: vi.fn(),
		retireOtherSnapshots: vi.fn().mockResolvedValue([]),
		retireSnapshot: vi.fn(),
		listRetiredSnapshots: vi.fn().mockResolvedValue([]),
		deleteSnapshotRecord: vi.fn(),
		membersBySnapshot: vi.fn().mockResolvedValue([]),
		withAdvisoryLock: vi.fn(async (_key: number, fn: () => Promise<unknown>) =>
			fn(),
		),
		listReapableSandboxes: vi.fn().mockResolvedValue([]),
		...overrides,
	}));
}

describe("openWorkspace", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("happy path: branch ref creates sandbox from snapshot", async () => {
		const fakeSnapshot = {
			id: "snp-1",
			sandboxGroupId: "sbg-1",
			name: "test",
			repo: "jacobprall/render-factory-sample",
			baseSha: "snap-sha",
			lockfileHash: FAKE_HASH,
			buildKey: "key-1",
			status: "available" as const,
			createdAt: new Date().toISOString(),
			expiresAt: null,
			retiredAt: null,
		};

		const fakeSb = createFakeSandbox([
			{
				match: "manifest.json",
				result: {
					output: JSON.stringify({
						baseSha: "snap-sha",
						buildKey: "key-1",
					}),
					exitCode: 0,
				},
			},
			{
				match: "rev-parse HEAD",
				result: { output: "snap-sha\n", exitCode: 0 },
			},
			{
				match: ".git/config",
				result: {
					output: `[remote "origin"]\n\turl = https://github.com/jacobprall/render-factory-sample.git\n`,
					exitCode: 0,
				},
			},
			{
				match: "remote get-url",
				result: {
					output: "https://github.com/jacobprall/render-factory-sample.git\n",
					exitCode: 0,
				},
			},
			{
				match: "rev-parse",
				result: { output: "tip-sha\n", exitCode: 0 },
			},
			{ match: "checkout", result: { output: "", exitCode: 0 } },
		]);

		const recordedSandboxes: unknown[] = [];
		mockStore({
			recordSandbox: vi.fn(async (input: unknown) => {
				recordedSandboxes.push(input);
			}),
		});
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
			createSandbox: vi
				.fn()
				.mockResolvedValue({ sandbox: fakeSb, networkPolicy: undefined }),
			getSandboxInfo: vi.fn(),
			Sandbox: vi.fn(),
			SandboxSnapshotNotFoundError: class extends Error {},
		}));
		vi.doMock("../app/workspaces/snapshot.js", () => ({
			ensureSnapshot: vi
				.fn()
				.mockResolvedValue({ snapshot: fakeSnapshot, rebuilt: false }),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
			verifyNoCredentialLeak: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { openWorkspace } = await import("../app/workspaces/workspace.js");
		const result = await openWorkspace("run-1", {
			kind: "branch",
			name: "main",
		});

		expect(result).toBeDefined();
		expect(result.baseSha).toBe("tip-sha");
		expect(result.headSha).toBe("tip-sha");

		// Row recorded before create
		expect(recordedSandboxes.length).toBe(1);
		const recorded = recordedSandboxes[0] as Record<string, unknown>;
		expect(recorded.role).toBe("run");
		expect(recorded.runId).toBe("run-1");
		expect(recorded.snapshotId).toBe("snp-1");
		expect(recorded.status).toBe("creating");
	});

	it("PR ref sets baseSha = merge-base", async () => {
		const fakeSnapshot = {
			id: "snp-pr",
			sandboxGroupId: "sbg-1",
			name: "test",
			repo: "jacobprall/render-factory-sample",
			baseSha: "snap-sha",
			lockfileHash: FAKE_HASH,
			buildKey: "key-1",
			status: "available" as const,
			createdAt: new Date().toISOString(),
			expiresAt: null,
			retiredAt: null,
		};

		const fakeSb = createFakeSandbox([
			{
				match: "manifest.json",
				result: {
					output: JSON.stringify({ baseSha: "snap-sha", buildKey: "key-1" }),
					exitCode: 0,
				},
			},
			{
				match: "rev-parse HEAD",
				result: { output: "snap-sha\n", exitCode: 0 },
			},
			{
				match: ".git/config",
				result: {
					output: `[remote "origin"]\n\turl = https://github.com/jacobprall/render-factory-sample.git\n`,
					exitCode: 0,
				},
			},
			{
				match: "remote get-url",
				result: {
					output: "https://github.com/jacobprall/render-factory-sample.git\n",
					exitCode: 0,
				},
			},
			{ match: "checkout", result: { output: "", exitCode: 0 } },
			{
				match: "merge-base",
				result: { output: "merge-base-sha\n", exitCode: 0 },
			},
		]);

		mockStore();
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
			createSandbox: vi
				.fn()
				.mockResolvedValue({ sandbox: fakeSb, networkPolicy: undefined }),
			getSandboxInfo: vi.fn(),
			Sandbox: vi.fn(),
			SandboxSnapshotNotFoundError: class extends Error {},
		}));
		vi.doMock("../app/workspaces/snapshot.js", () => ({
			ensureSnapshot: vi
				.fn()
				.mockResolvedValue({ snapshot: fakeSnapshot, rebuilt: false }),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
			verifyNoCredentialLeak: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { openWorkspace } = await import("../app/workspaces/workspace.js");
		const result = await openWorkspace("run-pr", {
			kind: "pull",
			number: 42,
			headSha: "pr-head-sha",
		});

		expect(result.headSha).toBe("pr-head-sha");
		expect(result.baseSha).toBe("merge-base-sha");
	});

	it("sha ref sets baseSha = headSha = sha", async () => {
		const fakeSnapshot = {
			id: "snp-sha",
			sandboxGroupId: "sbg-1",
			name: "test",
			repo: "jacobprall/render-factory-sample",
			baseSha: "snap-sha",
			lockfileHash: FAKE_HASH,
			buildKey: "key-1",
			status: "available" as const,
			createdAt: new Date().toISOString(),
			expiresAt: null,
			retiredAt: null,
		};

		const fakeSb = createFakeSandbox([
			{
				match: "manifest.json",
				result: {
					output: JSON.stringify({ baseSha: "snap-sha", buildKey: "key-1" }),
					exitCode: 0,
				},
			},
			{
				match: "rev-parse HEAD",
				result: { output: "snap-sha\n", exitCode: 0 },
			},
			{
				match: ".git/config",
				result: {
					output: `[remote "origin"]\n\turl = https://github.com/jacobprall/render-factory-sample.git\n`,
					exitCode: 0,
				},
			},
			{
				match: "remote get-url",
				result: {
					output: "https://github.com/jacobprall/render-factory-sample.git\n",
					exitCode: 0,
				},
			},
			{ match: "checkout", result: { output: "", exitCode: 0 } },
		]);

		mockStore();
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
			createSandbox: vi
				.fn()
				.mockResolvedValue({ sandbox: fakeSb, networkPolicy: undefined }),
			getSandboxInfo: vi.fn(),
			Sandbox: vi.fn(),
			SandboxSnapshotNotFoundError: class extends Error {},
		}));
		vi.doMock("../app/workspaces/snapshot.js", () => ({
			ensureSnapshot: vi
				.fn()
				.mockResolvedValue({ snapshot: fakeSnapshot, rebuilt: false }),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
			verifyNoCredentialLeak: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { openWorkspace } = await import("../app/workspaces/workspace.js");
		const result = await openWorkspace("run-sha", {
			kind: "sha",
			sha: "exact-sha-123",
		});

		expect(result.baseSha).toBe("exact-sha-123");
		expect(result.headSha).toBe("exact-sha-123");
	});

	it("wider-policy refusal terminates and marks failed", async () => {
		const fakeSnapshot = {
			id: "snp-policy",
			sandboxGroupId: "sbg-1",
			name: "test",
			repo: "jacobprall/render-factory-sample",
			baseSha: "snap-sha",
			lockfileHash: FAKE_HASH,
			buildKey: "key-1",
			status: "available" as const,
			createdAt: new Date().toISOString(),
			expiresAt: null,
			retiredAt: null,
		};

		const fakeSb = createFakeSandbox([
			// No manifest response needed — policy check happens before verification
		]);
		const failedIds: string[] = [];

		mockStore({
			markSandboxFailed: vi.fn(async (id: string) => {
				failedIds.push(id);
			}),
		});
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
			createSandbox: vi.fn().mockResolvedValue({
				sandbox: fakeSb,
				networkPolicy: { default: "allow-all" },
			}),
			getSandboxInfo: vi.fn(),
			Sandbox: vi.fn(),
			SandboxSnapshotNotFoundError: class extends Error {},
		}));
		vi.doMock("../app/workspaces/snapshot.js", () => ({
			ensureSnapshot: vi
				.fn()
				.mockResolvedValue({ snapshot: fakeSnapshot, rebuilt: false }),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
			verifyNoCredentialLeak: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		vi.doMock("../factory.config.js", () => ({
			factoryConfig: {
				repos: [
					{
						owner: "jacobprall",
						name: "render-factory-sample",
						baseBranch: "main",
						repoDir: "/home/user/repo",
						setup: { install: "npm ci" },
						verify: [],
					},
				],
				sandbox: {
					timeoutSeconds: 7200,
					network: { default: "deny-all" },
				},
			},
		}));
		mockConfig();

		const { openWorkspace } = await import("../app/workspaces/workspace.js");
		await expect(
			openWorkspace("run-policy", { kind: "branch", name: "main" }),
		).rejects.toThrow("wider policy");

		expect(fakeSb.terminated.value).toBe(true);
		expect(failedIds.length).toBeGreaterThan(0);
	});

	it("manifest verification failure terminates and marks failed", async () => {
		const fakeSnapshot = {
			id: "snp-bad-manifest",
			sandboxGroupId: "sbg-1",
			name: "test",
			repo: "jacobprall/render-factory-sample",
			baseSha: "snap-sha",
			lockfileHash: FAKE_HASH,
			buildKey: "key-1",
			status: "available" as const,
			createdAt: new Date().toISOString(),
			expiresAt: null,
			retiredAt: null,
		};

		const fakeSb = createFakeSandbox([
			{
				match: "manifest.json",
				result: {
					output: JSON.stringify({
						baseSha: "WRONG-SHA",
						buildKey: "key-1",
					}),
					exitCode: 0,
				},
			},
		]);

		const failedIds: string[] = [];
		mockStore({
			markSandboxFailed: vi.fn(async (id: string) => {
				failedIds.push(id);
			}),
		});
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
			createSandbox: vi
				.fn()
				.mockResolvedValue({ sandbox: fakeSb, networkPolicy: undefined }),
			getSandboxInfo: vi.fn(),
			Sandbox: vi.fn(),
			SandboxSnapshotNotFoundError: class extends Error {},
		}));
		vi.doMock("../app/workspaces/snapshot.js", () => ({
			ensureSnapshot: vi
				.fn()
				.mockResolvedValue({ snapshot: fakeSnapshot, rebuilt: false }),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
			verifyNoCredentialLeak: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { openWorkspace } = await import("../app/workspaces/workspace.js");
		await expect(
			openWorkspace("run-bad", { kind: "branch", name: "main" }),
		).rejects.toThrow("manifest baseSha");

		expect(fakeSb.terminated.value).toBe(true);
		expect(failedIds.length).toBeGreaterThan(0);
	});

	it("SandboxSnapshotNotFoundError retires that snapshot and retries once", async () => {
		const fakeSnapshot = {
			id: "snp-gone",
			sandboxGroupId: "sbg-1",
			name: "test",
			repo: "jacobprall/render-factory-sample",
			baseSha: "sha-1",
			lockfileHash: FAKE_HASH,
			buildKey: "key-1",
			status: "available" as const,
			createdAt: new Date().toISOString(),
			expiresAt: null,
			retiredAt: null,
		};

		const goodSb = createFakeSandbox([
			{
				match: "manifest.json",
				result: {
					output: JSON.stringify({ baseSha: "sha-1", buildKey: "key-1" }),
					exitCode: 0,
				},
			},
			{
				match: "rev-parse HEAD",
				result: { output: "sha-1\n", exitCode: 0 },
			},
			{
				match: ".git/config",
				result: {
					output: `[remote "origin"]\n\turl = https://github.com/jacobprall/render-factory-sample.git\n`,
					exitCode: 0,
				},
			},
			{
				match: "remote get-url",
				result: {
					output: "https://github.com/jacobprall/render-factory-sample.git\n",
					exitCode: 0,
				},
			},
			{ match: "rev-parse", result: { output: "sha-1\n", exitCode: 0 } },
			{ match: "checkout", result: { output: "", exitCode: 0 } },
		]);

		class FakeSnapshotNotFoundError extends Error {
			constructor() {
				super("snapshot gone");
				this.name = "SandboxSnapshotNotFoundError";
			}
		}

		let createCallCount = 0;
		const retiredSnapshotIds: string[] = [];
		const mockEnsureSnapshot = vi
			.fn()
			.mockResolvedValue({ snapshot: fakeSnapshot, rebuilt: false });

		mockStore({
			retireSnapshot: vi.fn(async (id: string) => {
				retiredSnapshotIds.push(id);
			}),
		});

		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
			createSandbox: vi.fn().mockImplementation(async () => {
				createCallCount++;
				if (createCallCount === 1) {
					throw new FakeSnapshotNotFoundError();
				}
				return { sandbox: goodSb, networkPolicy: undefined };
			}),
			getSandboxInfo: vi.fn(),
			Sandbox: vi.fn(),
			SandboxSnapshotNotFoundError: FakeSnapshotNotFoundError,
		}));
		vi.doMock("../app/workspaces/snapshot.js", () => ({
			ensureSnapshot: mockEnsureSnapshot,
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
			verifyNoCredentialLeak: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { openWorkspace } = await import("../app/workspaces/workspace.js");
		const result = await openWorkspace("run-rebuild", {
			kind: "branch",
			name: "main",
		});

		expect(result).toBeDefined();
		expect(retiredSnapshotIds).toContain("snp-gone");
		expect(mockEnsureSnapshot).toHaveBeenCalledTimes(2);
	});

	it("lockfile change triggers reinstall", async () => {
		const fakeSnapshot = {
			id: "snp-lf",
			sandboxGroupId: "sbg-1",
			name: "test",
			repo: "jacobprall/render-factory-sample",
			baseSha: "snap-sha",
			lockfileHash: "old-hash",
			buildKey: "key-1",
			status: "available" as const,
			createdAt: new Date().toISOString(),
			expiresAt: null,
			retiredAt: null,
		};

		const sandbox = createFakeSandbox([
			{
				match: "manifest.json",
				result: {
					output: JSON.stringify({ baseSha: "snap-sha", buildKey: "key-1" }),
					exitCode: 0,
				},
			},
			{
				match: "rev-parse HEAD",
				result: { output: "snap-sha\n", exitCode: 0 },
			},
			{
				match: ".git/config",
				result: {
					output: `[remote "origin"]\n\turl = https://github.com/jacobprall/render-factory-sample.git\n`,
					exitCode: 0,
				},
			},
			{
				match: "remote get-url",
				result: {
					output: "https://github.com/jacobprall/render-factory-sample.git\n",
					exitCode: 0,
				},
			},
			{ match: "rev-parse", result: { output: "tip-sha\n", exitCode: 0 } },
			{ match: "checkout", result: { output: "", exitCode: 0 } },
		]);

		let reinstallRan = false;
		const origMustRun = sandbox.mustRun;
		sandbox.mustRun = vi.fn(async (command: string, label: string) => {
			if (label.includes("Reinstall")) {
				reinstallRan = true;
				return "";
			}
			return origMustRun(command, label);
		}) as typeof sandbox.mustRun;

		mockStore();
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
			createSandbox: vi
				.fn()
				.mockResolvedValue({ sandbox, networkPolicy: undefined }),
			getSandboxInfo: vi.fn(),
			Sandbox: vi.fn(),
			SandboxSnapshotNotFoundError: class extends Error {},
		}));
		vi.doMock("../app/workspaces/snapshot.js", () => ({
			ensureSnapshot: vi
				.fn()
				.mockResolvedValue({ snapshot: fakeSnapshot, rebuilt: false }),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
			verifyNoCredentialLeak: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue("new-different-hash"),
		}));
		mockConfig();

		const { openWorkspace } = await import("../app/workspaces/workspace.js");
		await openWorkspace("run-lf", { kind: "branch", name: "main" });

		expect(reinstallRan).toBe(true);
	});
});

/* ── closeWorkspace tests ───────────────────────────────────────── */

describe("closeWorkspace", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("is idempotent (no sandboxes for run)", async () => {
		mockStore({ listSandboxesForRun: vi.fn().mockResolvedValue([]) });
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
		}));

		const { closeWorkspace } = await import("../app/workspaces/workspace.js");
		await closeWorkspace("run-no-sandboxes");
	});

	it("terminates and marks all sandboxes for a run", async () => {
		const terminatedIds: string[] = [];
		const markedIds: string[] = [];
		const fakeSb = {
			terminate: vi.fn(async () => {
				terminatedIds.push("sbx-1");
			}),
		};

		mockStore({
			listSandboxesForRun: vi
				.fn()
				.mockResolvedValue([
					{ id: "rec-1", providerId: "sbx-1", status: "ready" },
				]),
			markSandboxTerminated: vi.fn(async (id: string) => {
				markedIds.push(id);
			}),
		});
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue(fakeSb),
		}));

		const { closeWorkspace } = await import("../app/workspaces/workspace.js");
		await closeWorkspace("run-with-sandbox");

		expect(terminatedIds).toContain("sbx-1");
		expect(markedIds).toContain("rec-1");
	});

	it("marks row terminated even when terminate throws", async () => {
		const markedIds: string[] = [];
		const fakeSb = {
			terminate: vi.fn(async () => {
				throw new Error("platform gone");
			}),
		};

		mockStore({
			listSandboxesForRun: vi
				.fn()
				.mockResolvedValue([
					{ id: "rec-2", providerId: "sbx-2", status: "ready" },
				]),
			markSandboxTerminated: vi.fn(async (id: string) => {
				markedIds.push(id);
			}),
		});
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue(fakeSb),
		}));

		const { closeWorkspace } = await import("../app/workspaces/workspace.js");
		await closeWorkspace("run-fail-terminate");

		expect(markedIds).toContain("rec-2");
	});
});
