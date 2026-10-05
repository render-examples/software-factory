import { api } from "./client.js";
import { Sandbox } from "./sandbox.js";
import type { CreateSandboxOptions } from "./types.js";

const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;

export async function createSandbox(
	opts?: CreateSandboxOptions,
): Promise<Sandbox> {
	const { client, ownerId } = api();
	const created = await client.create({
		ownerId,
		timeoutSeconds: opts?.timeoutSeconds,
		...(opts?.networkPolicy ? { networkPolicy: opts.networkPolicy } : {}),
	});

	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = await client.get(created.id, ownerId);
		if (current?.status === "running") return new Sandbox(created.id);
		if (current?.status === "errored" || current?.status === "terminated") {
			throw new Error(
				`Sandbox ${created.id} entered terminal state: ${current.status}`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}

	throw new Error(
		`Sandbox ${created.id} was not ready within ${READY_TIMEOUT_MS}ms`,
	);
}

export function connectSandbox(sandboxId: string): Sandbox {
	return new Sandbox(sandboxId);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
