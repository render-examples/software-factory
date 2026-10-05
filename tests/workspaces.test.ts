import { createHash } from "node:crypto";
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

/* ── Credential tests ───────────────────────────────────────────── */

vi.mock("../app/github/auth.js", () => ({
	githubToken: vi.fn(async () => "ghs_test_token_12345"),
	resetTokenCache: vi.fn(),
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

/* ── Lease tests ────────────────────────────────────────────────── */

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
			lockfileHash: createHash("sha256").update("lock-content").digest("hex"),
			runId: "run-1",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		const fakeSb = createFakeSandbox([
			{ match: "rev-parse", result: { output: "abc123\n", exitCode: 0 } },
			{ match: "checkout", result: { output: "", exitCode: 0 } },
			{
				match: "package-lock.json",
				result: { output: "lock-content", exitCode: 0 },
			},
		]);

		const mockClaimWarm = vi.fn().mockResolvedValue(warmRecord);
		const mockPrepareSandbox = vi.fn();

		vi.doMock("../app/store/sandboxes.js", () => ({
			claimWarmSandbox: mockClaimWarm,
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
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
		vi.doMock("../app/config/env.js", () => ({
			target: () => ({
				owner: "jacobprall",
				name: "render-factory-sample",
				baseBranch: "main",
				repoDir: "/home/user/repo",
				setup: { install: "npm ci", browsers: true },
				verify: [],
			}),
			repository: () => ({
				owner: "jacobprall",
				repo: "render-factory-sample",
				fullName: "jacobprall/render-factory-sample",
			}),
		}));

		const { lease } = await import("../app/workspaces/lease.js");
		const result = await lease("run-1", { kind: "branch", name: "main" });

		expect(result.sandboxRecordId).toBe("warm-sb-1");
		expect(mockPrepareSandbox).not.toHaveBeenCalled();
		expect(mockClaimWarm).toHaveBeenCalledWith("run-1");
	});

	it("cold path prepares when no warm sandbox available", async () => {
		const coldSandbox = createFakeSandbox([
			{ match: "rev-parse", result: { output: "def456\n", exitCode: 0 } },
			{ match: "checkout", result: { output: "", exitCode: 0 } },
			{
				match: "package-lock.json",
				result: { output: "lock-content", exitCode: 0 },
			},
		]);

		const mockClaimWarm = vi.fn().mockResolvedValue(null);
		const mockLeaseSandbox = vi.fn();
		const mockPrepareSandbox = vi.fn().mockResolvedValue({
			sandbox: coldSandbox,
			sandboxRecordId: "cold-sb-1",
			baseSha: "def456",
			lockfileHash: createHash("sha256").update("lock-content").digest("hex"),
		});

		vi.doMock("../app/store/sandboxes.js", () => ({
			claimWarmSandbox: mockClaimWarm,
			leaseSandbox: mockLeaseSandbox,
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
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
		vi.doMock("../app/config/env.js", () => ({
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

		const { lease } = await import("../app/workspaces/lease.js");
		const result = await lease("run-2", { kind: "branch", name: "main" });

		expect(result.sandboxRecordId).toBe("cold-sb-1");
		expect(mockPrepareSandbox).toHaveBeenCalled();
		expect(mockLeaseSandbox).toHaveBeenCalledWith("cold-sb-1", "run-2");
	});

	it("PR ref fetches refs/pull/<n>/head and checks out headSha", async () => {
		const sandbox = createFakeSandbox([
			{ match: "checkout", result: { output: "", exitCode: 0 } },
			{
				match: "package-lock.json",
				result: { output: "lock-content", exitCode: 0 },
			},
		]);

		const lockHash = createHash("sha256").update("lock-content").digest("hex");
		const warmRecord = {
			id: "warm-pr-1",
			providerId: "sbx-warm-pr",
			status: "leased",
			baseSha: "abc123",
			lockfileHash: lockHash,
			runId: "run-pr-1",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		let fetchedRefspec = "";
		vi.doMock("../app/store/sandboxes.js", () => ({
			claimWarmSandbox: vi.fn().mockResolvedValue(warmRecord),
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
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
			fetchWithReadToken: vi.fn(
				async (_sb: unknown, _dir: string, refspec: string) => {
					fetchedRefspec = refspec;
				},
			),
		}));
		vi.doMock("../app/config/env.js", () => ({
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

		const { lease } = await import("../app/workspaces/lease.js");
		const result = await lease("run-pr-1", {
			kind: "pull",
			number: 42,
			headSha: "pr-sha-abc",
		});

		expect(result.headSha).toBe("pr-sha-abc");
		expect(fetchedRefspec).toBe("refs/pull/42/head");
	});

	it("lockfile change triggers reinstall", async () => {
		const priorHash = createHash("sha256")
			.update("old-lockfile-content")
			.digest("hex");
		const newLockContent = "new-lockfile-content";

		const sandbox = createFakeSandbox([
			{ match: "rev-parse", result: { output: "new-sha\n", exitCode: 0 } },
			{ match: "checkout", result: { output: "", exitCode: 0 } },
			{
				match: "package-lock.json",
				result: { output: newLockContent, exitCode: 0 },
			},
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

		const warmRecord = {
			id: "warm-lf-1",
			providerId: "sbx-warm-lf",
			status: "leased",
			baseSha: "old-sha",
			lockfileHash: priorHash,
			runId: "run-lf-1",
			createdAt: new Date().toISOString(),
			readyAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			leasedAt: new Date().toISOString(),
			releasedAt: null,
		};

		vi.doMock("../app/store/sandboxes.js", () => ({
			claimWarmSandbox: vi.fn().mockResolvedValue(warmRecord),
			leaseSandbox: vi.fn(),
			listSandboxesForRun: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
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
		vi.doMock("../app/config/env.js", () => ({
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

		const { lease } = await import("../app/workspaces/lease.js");
		await lease("run-lf-1", { kind: "branch", name: "main" });

		expect(reinstallRan).toBe(true);
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

		vi.doMock("../app/store/sandboxes.js", () => ({
			countSandboxesByStatus: vi.fn().mockResolvedValue(2),
			listRecyclableSandboxes: vi.fn().mockResolvedValue([]),
			listExpiredSandboxes: vi.fn().mockResolvedValue([]),
			markSandboxTerminated: vi.fn(),
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
		vi.doMock("../app/github/client.js", () => ({
			GitHub: FakeGitHub,
		}));
		vi.doMock("../app/github/auth.js", () => ({
			githubToken: vi.fn().mockResolvedValue("test-token"),
		}));
		vi.doMock("../app/config/env.js", () => ({
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

		// pool.size is 3, 2 in-flight → 1 new
		expect(prepareCount).toBe(1);
	});

	it("reapSandboxes terminates expired sandboxes", async () => {
		const terminatedIds: string[] = [];

		vi.doMock("../app/store/sandboxes.js", () => ({
			countSandboxesByStatus: vi.fn().mockResolvedValue(0),
			listRecyclableSandboxes: vi.fn().mockResolvedValue([]),
			listExpiredSandboxes: vi.fn().mockResolvedValue([
				{
					id: "exp-1",
					providerId: "sbx-exp-1",
					status: "warm",
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
			markSandboxTerminated: vi.fn().mockImplementation(async (id: string) => {
				terminatedIds.push(id);
			}),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue({
				terminate: vi.fn().mockResolvedValue(undefined),
			}),
		}));

		const { reapSandboxes } = await import("../app/workspaces/pool.js");
		await reapSandboxes();

		expect(terminatedIds).toContain("exp-1");
	});
});
