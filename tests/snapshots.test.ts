import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExecResult } from "../app/sandbox/types.js";

/* ── Fake Sandbox for snapshot tests ────────────────────────────── */

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
		id: "sbx-fake-builder",
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
		readFile: vi.fn(async (path: string): Promise<string> => {
			const resp = findResponse(path);
			if (resp.exitCode !== 0) throw new Error("readFile failed");
			return resp.output;
		}),
		writeFile: vi.fn(async () => {}),
		terminate: vi.fn(async () => {
			terminated.value = true;
		}),
		exec: vi.fn(),
		listDir: vi.fn(),
		download: vi.fn(),
	};
}

/* ── Pacer tests ────────────────────────────────────────────────── */

describe("pacer", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("spaces requests by at least the configured interval", async () => {
		const { paced, setPacerInterval, resetPacer } = await import(
			"../app/sandbox/pacer.js"
		);
		resetPacer();
		setPacerInterval(50);

		const timestamps: number[] = [];
		for (let i = 0; i < 3; i++) {
			await paced(async () => {
				timestamps.push(Date.now());
			});
		}

		for (let i = 1; i < timestamps.length; i++) {
			const gap = timestamps[i] - timestamps[i - 1];
			expect(gap).toBeGreaterThanOrEqual(40);
		}
	});

	it("retries on 429 and 503", async () => {
		const { paced, setPacerInterval, resetPacer } = await import(
			"../app/sandbox/pacer.js"
		);
		resetPacer();
		setPacerInterval(10);

		const { ClientError, ServerError } = await import("@renderinc/sdk");

		let attempt = 0;
		const result = await paced(
			async () => {
				attempt++;
				if (attempt === 1) throw new ClientError("rate limited", 429);
				if (attempt === 2) throw new ServerError("unavailable", 503);
				return "ok";
			},
			{ retryOn: [429, 503] },
		);

		expect(result).toBe("ok");
		expect(attempt).toBe(3);
	});

	it("does not retry non-retryable errors", async () => {
		const { paced, setPacerInterval, resetPacer } = await import(
			"../app/sandbox/pacer.js"
		);
		resetPacer();
		setPacerInterval(10);

		const { ClientError } = await import("@renderinc/sdk");

		let attempt = 0;
		await expect(
			paced(async () => {
				attempt++;
				throw new ClientError("bad request", 400);
			}),
		).rejects.toThrow("bad request");

		expect(attempt).toBe(1);
	});
});

/* ── Snapshot operations tests ──────────────────────────────────── */

describe("createAndWaitSnapshot", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("polls until available", async () => {
		let pollCount = 0;
		vi.doMock("../app/sandbox/client.js", () => ({
			api: () => ({
				client: {
					snapshots: {
						create: vi.fn().mockResolvedValue({
							id: "snp-test",
							sandboxGroupId: "sbg-1",
							status: "creating",
						}),
						get: vi.fn().mockImplementation(async () => {
							pollCount++;
							if (pollCount < 2) {
								return {
									id: "snp-test",
									sandboxGroupId: "sbg-1",
									status: "creating",
								};
							}
							return {
								id: "snp-test",
								sandboxGroupId: "sbg-1",
								status: "available",
								expiresAt: new Date(Date.now() + 86400_000).toISOString(),
							};
						}),
					},
				},
				ownerId: "tea-test",
			}),
		}));

		vi.doMock("../app/sandbox/pacer.js", () => ({
			paced: async <T>(fn: () => Promise<T>) => fn(),
			setPacerInterval: vi.fn(),
			getPacerInterval: () => 10,
			resetPacer: vi.fn(),
		}));

		const { createAndWaitSnapshot } = await import(
			"../app/sandbox/snapshots.js"
		);
		const snap = await createAndWaitSnapshot(
			{ sandboxId: "sbx-1", kind: "filesystem", name: "test" },
			{ pollMs: 10 },
		);

		expect(snap.status).toBe("available");
		expect(pollCount).toBeGreaterThanOrEqual(2);
	});

	it("throws on failed status", async () => {
		vi.doMock("../app/sandbox/client.js", () => ({
			api: () => ({
				client: {
					snapshots: {
						create: vi.fn().mockResolvedValue({
							id: "snp-fail",
							sandboxGroupId: "sbg-1",
							status: "failed",
							error: "capture error",
						}),
					},
				},
				ownerId: "tea-test",
			}),
		}));

		vi.doMock("../app/sandbox/pacer.js", () => ({
			paced: async <T>(fn: () => Promise<T>) => fn(),
			setPacerInterval: vi.fn(),
			getPacerInterval: () => 10,
			resetPacer: vi.fn(),
		}));

		const { createAndWaitSnapshot } = await import(
			"../app/sandbox/snapshots.js"
		);
		await expect(
			createAndWaitSnapshot(
				{ sandboxId: "sbx-1", kind: "filesystem", name: "test" },
				{ pollMs: 10 },
			),
		).rejects.toThrow("capture error");
	});
});

/* ── Build ordering tests ───────────────────────────────────────── */

describe("snapshot build ordering", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("builder terminated even on failure", async () => {
		const buildSb = createFakeSandbox([
			{ match: "clone", result: { output: "Cloning...", exitCode: 0 } },
			{
				match: ".git/config",
				result: {
					output: `[remote "origin"]\n\turl = https://github.com/test/repo.git\n`,
					exitCode: 0,
				},
			},
			{
				match: "remote get-url",
				result: {
					output: "https://github.com/test/repo.git\n",
					exitCode: 0,
				},
			},
			{ match: "rev-parse", result: { output: "sha-1\n", exitCode: 0 } },
			{
				match: "npm ci",
				result: { output: "install failed", exitCode: 1 },
			},
		]);

		vi.doMock("../app/sandbox/index.js", () => ({
			createSandbox: vi
				.fn()
				.mockResolvedValue({ sandbox: buildSb, networkPolicy: undefined }),
			createAndWaitSnapshot: vi.fn(),
			deleteSnapshot: vi.fn(),
			SandboxSnapshotNotFoundError: class extends Error {},
			connectSandbox: vi.fn(),
		}));
		vi.doMock("../app/store/index.js", () => ({
			withAdvisoryLock: vi.fn(
				async (_key: number, fn: () => Promise<unknown>) => fn(),
			),
			recordSandbox: vi.fn(),
			setSandboxProviderId: vi.fn(),
			markSandboxPreparing: vi.fn().mockResolvedValue(true),
			markSandboxFailed: vi.fn(),
			markSandboxTerminated: vi.fn(),
			currentSnapshot: vi.fn().mockResolvedValue(null),
			recordSnapshot: vi.fn(),
			retireOtherSnapshots: vi.fn().mockResolvedValue([]),
			listRetiredSnapshots: vi.fn().mockResolvedValue([]),
			deleteSnapshotRecord: vi.fn(),
			membersBySnapshot: vi.fn().mockResolvedValue([]),
		}));
		vi.doMock("../app/github/index.js", () => ({
			githubToken: vi.fn().mockResolvedValue("ghs_test"),
			GitHub: class {
				async getBranchTipSha() {
					return "sha-1";
				}
			},
		}));
		vi.doMock("../app/config/index.js", () => ({
			target: () => ({
				owner: "test",
				name: "repo",
				baseBranch: "main",
				repoDir: "/home/user/repo",
				setup: { install: "npm ci", browsers: false },
				verify: [],
			}),
			repository: () => ({
				owner: "test",
				repo: "repo",
				fullName: "test/repo",
			}),
		}));
		vi.doMock("../app/workspaces/credentials.js", () => ({
			cloneWithReadToken: vi.fn(),
			verifyNoCredentialLeak: vi.fn(),
		}));
		vi.doMock("../app/workspaces/hash.js", () => ({
			lockfileHashInSandbox: vi.fn().mockResolvedValue("hash-x"),
		}));

		const { ensureSnapshot } = await import("../app/workspaces/snapshot.js");

		await expect(ensureSnapshot()).rejects.toThrow("Install dependencies");
		expect(buildSb.terminated.value).toBe(true);
	});
});

/* ── ensureSnapshot skips when unchanged ────────────────────────── */

describe("ensureSnapshot", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("skips when snapshot is current", async () => {
		const existingSnapshot = {
			id: "snp-existing",
			sandboxGroupId: "sbg-1",
			name: "test",
			repo: "test/repo",
			baseSha: "sha-1",
			lockfileHash: "hash-x",
			buildKey: "", // will be matched by computeBuildKey
			status: "available" as const,
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
			retiredAt: null,
		};

		vi.doMock("../app/sandbox/index.js", () => ({
			createSandbox: vi.fn(),
			createAndWaitSnapshot: vi.fn(),
			deleteSnapshot: vi.fn(),
			SandboxSnapshotNotFoundError: class extends Error {},
			connectSandbox: vi.fn(),
		}));

		let buildCalled = false;
		vi.doMock("../app/store/index.js", () => ({
			withAdvisoryLock: vi.fn(
				async (_key: number, fn: () => Promise<unknown>) => fn(),
			),
			recordSandbox: vi.fn(() => {
				buildCalled = true;
			}),
			setSandboxProviderId: vi.fn(),
			markSandboxPreparing: vi.fn(),
			markSandboxFailed: vi.fn(),
			markSandboxTerminated: vi.fn(),
			currentSnapshot: vi.fn().mockImplementation(async () => {
				// Set buildKey to match what computeBuildKey returns
				return existingSnapshot;
			}),
			recordSnapshot: vi.fn(),
			retireOtherSnapshots: vi.fn().mockResolvedValue([]),
			listRetiredSnapshots: vi.fn().mockResolvedValue([]),
			deleteSnapshotRecord: vi.fn(),
		}));
		vi.doMock("../app/github/index.js", () => ({
			githubToken: vi.fn().mockResolvedValue("ghs_test"),
			GitHub: class {
				async getBranchTipSha() {
					return "sha-1";
				}
			},
		}));
		vi.doMock("../app/config/index.js", () => ({
			target: () => ({
				owner: "test",
				name: "repo",
				baseBranch: "main",
				repoDir: "/home/user/repo",
				setup: { install: "npm ci", browsers: false },
				verify: [],
			}),
			repository: () => ({
				owner: "test",
				repo: "repo",
				fullName: "test/repo",
			}),
		}));

		// We need to compute the expected build key to set on the snapshot
		const { createHash } = await import("node:crypto");
		const { PLAYWRIGHT_VERSION } = await import("../app/tools/index.js");
		const parts = [
			"sha-1",
			"npm ci",
			"no-browsers",
			PLAYWRIGHT_VERSION,
			"development",
		];
		existingSnapshot.buildKey = createHash("sha256")
			.update(parts.join("\n"))
			.digest("hex");

		const { ensureSnapshot } = await import("../app/workspaces/snapshot.js");
		const result = await ensureSnapshot();

		expect(result.rebuilt).toBe(false);
		expect(result.snapshot.id).toBe("snp-existing");
		expect(buildCalled).toBe(false);
	});
});

/* ── Reaper selection tests ─────────────────────────────────────── */

describe("reapSandboxes", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("terminates and marks each reapable sandbox", async () => {
		const terminatedIds: string[] = [];
		const markedIds: string[] = [];

		vi.doMock("../app/store/index.js", () => ({
			listReapableSandboxes: vi.fn().mockResolvedValue([
				{
					id: "reap-1",
					providerId: "sbx-reap-1",
					status: "ready",
					runId: "run-done",
					baseSha: null,
					lockfileHash: null,
					createdAt: new Date().toISOString(),
					readyAt: null,
					expiresAt: null,
					terminatedAt: null,
				},
				{
					id: "reap-2",
					providerId: "sbx-reap-2",
					status: "ready",
					runId: null,
					baseSha: null,
					lockfileHash: null,
					createdAt: new Date().toISOString(),
					readyAt: null,
					expiresAt: new Date(Date.now() - 60_000).toISOString(),
					terminatedAt: null,
				},
			]),
			markSandboxTerminated: vi.fn(async (id: string) => {
				markedIds.push(id);
			}),
			markSandboxFailed: vi.fn(),
		}));
		vi.doMock("../app/sandbox/index.js", () => ({
			connectSandbox: vi.fn().mockReturnValue({
				terminate: vi.fn(async () => {
					terminatedIds.push("ok");
				}),
			}),
		}));

		const { reapSandboxes } = await import("../app/workspaces/reap.js");
		await reapSandboxes();

		expect(terminatedIds).toHaveLength(2);
		expect(markedIds).toContain("reap-1");
		expect(markedIds).toContain("reap-2");
	});
});
