import { factoryConfig } from "../../factory.config.js";
import { connectSandbox } from "../sandbox/index.js";
import {
	listReapableSandboxes,
	markSandboxTerminated,
	markSandboxFailed,
} from "../store/index.js";

/**
 * Terminate sandboxes that should no longer be running.
 * Only touches sandboxes recorded in the `sandboxes` table.
 */
export async function reapSandboxes(): Promise<void> {
	const builderTimeout = factoryConfig.sandbox.builderTimeoutSeconds ?? 7_200;
	const reapable = await listReapableSandboxes(builderTimeout);

	for (const record of reapable) {
		try {
			if (record.providerId) {
				const sb = connectSandbox(record.providerId);
				await sb.terminate();
			}
		} catch (err) {
			console.error(
				`Failed to terminate reapable sandbox ${record.id}:`,
				err instanceof Error ? err.message : err,
			);
		}

		if (record.status === "creating" || record.status === "preparing") {
			await markSandboxFailed(record.id);
		} else {
			await markSandboxTerminated(record.id);
		}
	}
}
