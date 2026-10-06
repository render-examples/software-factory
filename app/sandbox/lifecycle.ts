import { api } from "./client.js";
import { paced } from "./pacer.js";
import { Sandbox } from "./sandbox.js";
import type { CreateSandboxOptions, SandboxNetworkPolicy } from "./types.js";

const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;

export interface CreateSandboxResult {
	sandbox: Sandbox;
	networkPolicy?: SandboxNetworkPolicy;
}

export async function createSandbox(
	opts?: CreateSandboxOptions,
): Promise<CreateSandboxResult> {
	const { client, ownerId } = api();
	const created = await paced(() =>
		client.create({
			ownerId,
			timeoutSeconds: opts?.timeoutSeconds,
			...(opts?.networkPolicy ? { networkPolicy: opts.networkPolicy } : {}),
			...(opts?.snapshotId ? { snapshotId: opts.snapshotId } : {}),
		}),
	);

	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = await paced(() => client.get(created.id, ownerId), {
			retryOn: [404, 429, 503],
		});
		if (current?.status === "running") {
			return {
				sandbox: new Sandbox(created.id),
				networkPolicy: current.networkPolicy as
					| SandboxNetworkPolicy
					| undefined,
			};
		}
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

/** Retrieve a sandbox's current info, including its network policy. */
export async function getSandboxInfo(
	sandboxId: string,
): Promise<{ networkPolicy?: SandboxNetworkPolicy }> {
	const { client, ownerId } = api();
	const info = await paced(() => client.get(sandboxId, ownerId), {
		retryOn: [429, 503],
	});
	return {
		networkPolicy: info?.networkPolicy as SandboxNetworkPolicy | undefined,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
