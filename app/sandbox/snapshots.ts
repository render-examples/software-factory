import { setTimeout as sleep } from "node:timers/promises";
import { SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type {
	SandboxSnapshotCreateInput,
	SandboxSnapshotDeleteInput,
	SandboxSnapshotGetInput,
	SandboxSnapshotListInput,
	SandboxSnapshotWithCursor,
	SandboxSnapshot,
} from "@renderinc/sdk/experimental";
import { api } from "./client.js";
import { paced } from "./pacer.js";

export { SandboxSnapshotNotFoundError };
export type { SandboxSnapshot };

const SNAPSHOT_POLL_MS = 3_000;
const SNAPSHOT_TIMEOUT_MS = 20 * 60_000;

export async function createSnapshot(
	input: SandboxSnapshotCreateInput,
): Promise<SandboxSnapshot> {
	const { client } = api();
	return paced(() => client.snapshots.create(input));
}

export async function getSnapshot(
	input: SandboxSnapshotGetInput,
): Promise<SandboxSnapshot> {
	const { client } = api();
	return paced(() => client.snapshots.get(input), { retryOn: [429, 503] });
}

export async function listSnapshots(
	input: SandboxSnapshotListInput,
): Promise<SandboxSnapshotWithCursor[]> {
	const { client } = api();
	return paced(() => client.snapshots.list(input), { retryOn: [429, 503] });
}

export async function deleteSnapshot(
	input: SandboxSnapshotDeleteInput,
): Promise<void> {
	const { client } = api();
	await paced(() => client.snapshots.delete(input), { retryOn: [429, 503] });
}

/**
 * Create a snapshot and poll until it becomes `available`.
 * Throws on timeout or `failed` status.
 */
export async function createAndWaitSnapshot(
	input: SandboxSnapshotCreateInput,
	opts?: { timeoutMs?: number; pollMs?: number },
): Promise<SandboxSnapshot> {
	let snap = await createSnapshot(input);
	const timeout = opts?.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
	const poll = opts?.pollMs ?? SNAPSHOT_POLL_MS;
	const until = Date.now() + timeout;

	while (snap.status === "creating") {
		if (Date.now() > until) {
			throw new Error(`Snapshot ${snap.id} still creating after ${timeout}ms`);
		}
		await sleep(poll);
		snap = await getSnapshot({
			sandboxGroupId: snap.sandboxGroupId,
			snapshotId: snap.id,
		});
	}

	if (snap.status !== "available") {
		throw new Error(
			`Snapshot ${snap.id} ${snap.status}: ${snap.error ?? "no error given"}`,
		);
	}

	return snap;
}
