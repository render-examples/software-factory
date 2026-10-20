import { task } from "@renderinc/sdk/workflows";
import { requireRepo, TASKS } from "../config/index.js";
import { RefreshSnapshotInput } from "../schemas/tasks.js";
import { buildSnapshot, sandboxClient } from "../sandbox/index.js";

/** Rebuilds a repository's named snapshot at a pushed base-branch commit. Started by the gateway on push. */
export const refreshSnapshot = task(
	{
		name: TASKS.refreshSnapshot,
		timeoutSeconds: 3600,
		retry: { maxRetries: 1, waitDurationMs: 30_000, backoffScaling: 1 },
	},
	async (_ctx, raw: unknown): Promise<{ snapshotId: string; repo: string; sha: string }> => {
		const input = RefreshSnapshotInput.parse(raw);
		const repo = requireRepo(input.repo, input.installationId);
		const built = await buildSnapshot(await sandboxClient(), repo, input.sha);
		return { snapshotId: built.id, repo: repo.fullName, sha: input.sha };
	},
);
