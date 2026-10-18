import type { TaskContext } from "@renderinc/sdk/workflows";
import { describe, expect, it, vi } from "vitest";

const buildSnapshot = vi.fn(async (_client: unknown, repo: { fullName: string }, sha: string) => ({
	id: "snp-1",
	sandboxGroupId: "sbg-1",
	name: "factory-x",
	manifest: { repo: repo.fullName, sha },
}));
vi.mock("../app/sandbox/index.js", () => ({ buildSnapshot, sandboxClient: async () => ({ fake: true }) }));

const { refreshSnapshot } = await import("../app/workflows/refresh-snapshot.js");
const { TASKS } = await import("../app/config/index.js");

const ctx = { metadata: {}, run: async () => undefined } as unknown as TaskContext;
const SHA = "a".repeat(40);
const REPO = "render-examples/render-factory-example-target";

describe("refresh-snapshot task", () => {
	it("registers under its task name and builds the configured repository at the pushed commit", async () => {
		expect(refreshSnapshot.name).toBe(TASKS.refreshSnapshot);
		const result = await refreshSnapshot.func(ctx, { repo: REPO, installationId: 3, sha: SHA });
		expect(result).toEqual({ snapshotId: "snp-1", repo: REPO, sha: SHA });
		expect(buildSnapshot).toHaveBeenCalledTimes(1);
		expect(buildSnapshot.mock.calls[0]?.[1]).toMatchObject({ fullName: REPO, installationId: 3, owner: "render-examples" });
	});

	it("rejects invalid input and unconfigured repositories", async () => {
		await expect(refreshSnapshot.func(ctx, { repo: REPO, installationId: 3, sha: "main" })).rejects.toThrow();
		await expect(refreshSnapshot.func(ctx, { repo: "acme/nope", installationId: 3, sha: SHA })).rejects.toThrow("not configured");
	});
});
