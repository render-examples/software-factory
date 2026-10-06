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

/* ── Lease tests ────────────────────────────────────────────────── */

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

describe("lease logic", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("warm path skips cold preparation", async () => {
		const warmRecord = {
			id: "warm-sb-1",
			providerId: "sbx-warm-1",
			status: "leased",
			baseSha: "abc123",
			lockfileHash: FAKE_HASH,
			runId: "run-1",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		const fakeSb = createFakeSandbox([
			{ match: "rev-parse", result: { output: "tip-sha\n", exitCode: 0 } },
			{ match: "checkout", result: { output: "", exitCode: 0 } },
			{
				match: "sha256sum",
				result: { output: `${FAKE_HASH}  pkg\n`, exitCode: 0 },
			},
		]);

		const mockClaimWarm = vi.fn().mockResolvedValue(warmRecord);
		const mockPrepareSandbox = vi.fn();

		vi.doMock("../app/store/index.js", () => ({
			claimWarmSandbox: mockClaimWarm,
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue(fakeSb),
			createSandbox: vi.fn(),
			Sandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/prepare.js", () => ({
			prepareSandbox: mockPrepareSandbox,
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { lease } = await import("../app/workspaces/lease.js");
		const result = await lease("run-1", { kind: "branch", name: "main" });

		expect(result.sandboxRecordId).toBe("warm-sb-1");
		expect(mockPrepareSandbox).not.toHaveBeenCalled();
		expect(mockClaimWarm).toHaveBeenCalledWith("run-1");
	});

	it("branch ref sets baseSha = headSha = fetched tip", async () => {
		const warmRecord = {
			id: "warm-br-1",
			providerId: "sbx-warm-br",
			status: "leased",
			baseSha: "old-sha",
			lockfileHash: FAKE_HASH,
			runId: "run-br",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		const fakeSb = createFakeSandbox([
			{
				match: "rev-parse",
				result: { output: "fetched-tip-sha\n", exitCode: 0 },
			},
			{ match: "checkout", result: { output: "", exitCode: 0 } },
		]);

		vi.doMock("../app/store/index.js", () => ({
			claimWarmSandbox: vi.fn().mockResolvedValue(warmRecord),
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue(fakeSb),
			createSandbox: vi.fn(),
			Sandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/prepare.js", () => ({
			prepareSandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { lease } = await import("../app/workspaces/lease.js");
		const result = await lease("run-br", { kind: "branch", name: "main" });

		expect(result.baseSha).toBe("fetched-tip-sha");
		expect(result.headSha).toBe("fetched-tip-sha");
		expect(result.baseBranch).toBe("main");
	});

	it("PR ref sets baseSha = merge-base and fetches base branch", async () => {
		const warmRecord = {
			id: "warm-pr-1",
			providerId: "sbx-warm-pr",
			status: "leased",
			baseSha: "old-sha",
			lockfileHash: FAKE_HASH,
			runId: "run-pr",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		const fakeSb = createFakeSandbox([
			{ match: "checkout", result: { output: "", exitCode: 0 } },
			{
				match: "merge-base",
				result: { output: "merge-base-sha\n", exitCode: 0 },
			},
		]);

		const fetchedRefspecs: string[] = [];
		vi.doMock("../app/store/index.js", () => ({
			claimWarmSandbox: vi.fn().mockResolvedValue(warmRecord),
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue(fakeSb),
			createSandbox: vi.fn(),
			Sandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/prepare.js", () => ({
			prepareSandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(
				async (_sb: unknown, _dir: string, refspec: string) => {
					fetchedRefspecs.push(refspec);
				},
			),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { lease } = await import("../app/workspaces/lease.js");
		const result = await lease("run-pr", {
			kind: "pull",
			number: 42,
			headSha: "pr-head-sha",
		});

		expect(result.headSha).toBe("pr-head-sha");
		expect(result.baseSha).toBe("merge-base-sha");
		expect(fetchedRefspecs).toContain("refs/pull/42/head");
		expect(fetchedRefspecs).toContain("main");
	});

	it("sha ref sets baseSha = headSha = sha", async () => {
		const warmRecord = {
			id: "warm-sha-1",
			providerId: "sbx-warm-sha",
			status: "leased",
			baseSha: "old-sha",
			lockfileHash: FAKE_HASH,
			runId: "run-sha",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		const fakeSb = createFakeSandbox([
			{ match: "checkout", result: { output: "", exitCode: 0 } },
		]);

		vi.doMock("../app/store/index.js", () => ({
			claimWarmSandbox: vi.fn().mockResolvedValue(warmRecord),
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue(fakeSb),
			createSandbox: vi.fn(),
			Sandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/prepare.js", () => ({
			prepareSandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { lease } = await import("../app/workspaces/lease.js");
		const result = await lease("run-sha", {
			kind: "sha",
			sha: "exact-sha-123",
		});

		expect(result.baseSha).toBe("exact-sha-123");
		expect(result.headSha).toBe("exact-sha-123");
	});

	it("cold path passes leaseTo to prepareSandbox", async () => {
		const coldSandbox = createFakeSandbox([
			{ match: "rev-parse", result: { output: "def456\n", exitCode: 0 } },
			{ match: "checkout", result: { output: "", exitCode: 0 } },
		]);

		const mockPrepareSandbox = vi.fn().mockResolvedValue({
			sandbox: coldSandbox,
			sandboxRecordId: "cold-sb-1",
			baseSha: "def456",
			lockfileHash: FAKE_HASH,
		});

		vi.doMock("../app/store/index.js", () => ({
			claimWarmSandbox: vi.fn().mockResolvedValue(null),
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn(),
			createSandbox: vi.fn(),
			Sandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/prepare.js", () => ({
			prepareSandbox: mockPrepareSandbox,
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { lease } = await import("../app/workspaces/lease.js");
		await lease("run-cold", { kind: "branch", name: "main" });

		expect(mockPrepareSandbox).toHaveBeenCalledWith({ leaseTo: "run-cold" });
	});

	it("lockfile change triggers reinstall", async () => {
		const warmRecord = {
			id: "warm-lf-1",
			providerId: "sbx-warm-lf",
			status: "leased",
			baseSha: "old-sha",
			lockfileHash: "old-hash",
			runId: "run-lf-1",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		const sandbox = createFakeSandbox([
			{ match: "rev-parse", result: { output: "sha\n", exitCode: 0 } },
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

		vi.doMock("../app/store/index.js", () => ({
			claimWarmSandbox: vi.fn().mockResolvedValue(warmRecord),
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue(sandbox),
			createSandbox: vi.fn(),
			Sandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/prepare.js", () => ({
			prepareSandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue("new-different-hash"),
		}));
		mockConfig();

		const { lease } = await import("../app/workspaces/lease.js");
		await lease("run-lf-1", { kind: "branch", name: "main" });

		expect(reinstallRan).toBe(true);
	});

	it("retries with cold sandbox when warm fails (item 8)", async () => {
		const warmRecord = {
			id: "warm-fail-1",
			providerId: "sbx-warm-fail",
			status: "leased",
			baseSha: "sha",
			lockfileHash: FAKE_HASH,
			runId: "run-retry",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		const failSb = createFakeSandbox([]);

		const coldSb = createFakeSandbox([
			{ match: "rev-parse", result: { output: "cold-sha\n", exitCode: 0 } },
			{ match: "checkout", result: { output: "", exitCode: 0 } },
		]);

		const mockPrepareSandbox = vi.fn().mockResolvedValue({
			sandbox: coldSb,
			sandboxRecordId: "cold-retry-1",
			baseSha: "cold-sha",
			lockfileHash: FAKE_HASH,
		});

		let fetchCallCount = 0;
		vi.doMock("../app/store/index.js", () => ({
			claimWarmSandbox: vi.fn().mockResolvedValue(warmRecord),
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue(failSb),
			createSandbox: vi.fn(),
			Sandbox: vi.fn(),
		}));
		vi.doMock("../app/workspaces/prepare.js", () => ({
			prepareSandbox: mockPrepareSandbox,
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			fetchWithReadToken: vi.fn().mockImplementation(async () => {
				fetchCallCount++;
				if (fetchCallCount === 1) {
					throw new Error("Platform sandbox gone");
				}
			}),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue(FAKE_HASH),
		}));
		mockConfig();

		const { lease } = await import("../app/workspaces/lease.js");
		const result = await lease("run-retry", {
			kind: "branch",
			name: "main",
		});

		expect(result.sandboxRecordId).toBe("cold-retry-1");
		expect(mockPrepareSandbox).toHaveBeenCalledWith({ leaseTo: "run-retry" });
		expect(failSb.terminated.value).toBe(true);
	});
});

/* ── Pool decision tests ────────────────────────────────────────── */

describe("pool decisions", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("maintainPool counts in-flight rows to avoid over-provisioning", async () => {
		let prepareCount = 0;

		vi.doMock("../app/store/index.js", () => ({
			countPoolSandboxes: vi.fn().mockResolvedValue(2),
			claimRecyclableSandboxes: vi.fn().mockResolvedValue([]),
			claimExpiredWarmSandboxes: vi.fn().mockResolvedValue([]),
			listTerminalLeasedSandboxes: vi.fn().mockResolvedValue([]),
			listStuckInFlightSandboxes: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/workspaces/prepare.js", () => ({
			prepareSandbox: vi.fn().mockImplementation(async () => {
				prepareCount++;
				return {
					sandbox: createFakeSandbox([]),
					sandboxRecordId: `new-sb-${prepareCount}`,
					baseSha: "sha",
					lockfileHash: "hash",
				};
			}),
		}));

		class FakeGitHub {
			async getBranchTipSha() {
				return "current-sha";
			}
		}
		vi.doMock("../app/github/index.js", () => ({
			GitHub: FakeGitHub,
			githubToken: vi.fn().mockResolvedValue("test-token"),
		}));
		vi.doMock("../app/config/index.js", () => ({
			target: () => ({
				owner: "test",
				name: "repo",
				baseBranch: "main",
				repoDir: "/home/user/repo",
				setup: { install: "npm ci" },
			}),
			repository: () => ({
				owner: "test",
				repo: "repo",
				fullName: "test/repo",
			}),
		}));

		const { maintainPool } = await import("../app/workspaces/pool.js");
		await maintainPool();

		expect(prepareCount).toBe(1);
	});

	it("reapSandboxes terminates expired warm sandboxes atomically", async () => {
		const terminatedIds: string[] = [];

		vi.doMock("../app/store/index.js", () => ({
			listTerminalLeasedSandboxes: vi.fn().mockResolvedValue([]),
			claimExpiredWarmSandboxes: vi.fn().mockResolvedValue([
				{
					id: "exp-1",
					providerId: "sbx-exp-1",
					status: "released",
					baseSha: null,
					lockfileHash: null,
					runId: null,
					createdAt: new Date().toISOString(),
					readyAt: null,
					expiresAt: new Date(Date.now() - 1000).toISOString(),
					leasedAt: null,
					releasedAt: null,
				},
			]),
			listStuckInFlightSandboxes: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn().mockImplementation(async (id: string) => {
				terminatedIds.push(id);
			}),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue({
				terminate: vi.fn().mockResolvedValue(undefined),
			}),
		}));

		const { reapSandboxes } = await import("../app/workspaces/pool.js");
		await reapSandboxes();

		// expired warm sandboxes are already transitioned by the atomic claim
		// terminal leased ones go through markSandboxTerminated
		expect(terminatedIds).toHaveLength(0);
	});

	it("reapSandboxes marks stuck in-flight rows as failed", async () => {
		const failedIds: string[] = [];

		vi.doMock("../app/store/index.js", () => ({
			listTerminalLeasedSandboxes: vi.fn().mockResolvedValue([]),
			claimExpiredWarmSandboxes: vi.fn().mockResolvedValue([]),
			listStuckInFlightSandboxes: vi.fn().mockResolvedValue([
				{
					id: "stuck-1",
					providerId: "sbx-stuck-1",
					status: "creating",
					baseSha: null,
					lockfileHash: null,
					runId: null,
					createdAt: new Date(Date.now() - 3600_000).toISOString(),
					readyAt: null,
					expiresAt: null,
					leasedAt: null,
					releasedAt: null,
				},
			]),
			markSandboxTerminated: vi.fn(),
			markSandboxFailed: vi
				.fn()
				.mockImplementation(async (id: string) => failedIds.push(id)),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue({
				terminate: vi.fn().mockResolvedValue(undefined),
			}),
		}));

		const { reapSandboxes } = await import("../app/workspaces/pool.js");
		await reapSandboxes();

		expect(failedIds).toContain("stuck-1");
	});
});
