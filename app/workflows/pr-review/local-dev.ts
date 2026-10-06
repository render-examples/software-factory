import type { Sandbox } from "../../sandbox/index.js";
import { shellEscape } from "../../shell/index.js";
import { putArtifact } from "../../store/index.js";
import { target } from "../../config/index.js";

export interface LocalDevResult {
	healthy: boolean;
	port: number;
	skippedReason?: string;
}

/**
 * Start the dev server in the sandbox background and poll until it is healthy.
 * Returns { healthy: true } when the health check passes, or
 * { healthy: false, skippedReason } with the log tail when it does not.
 */
export async function startLocalDev(
	sandbox: Sandbox,
	runId: string,
	repoDir: string,
): Promise<LocalDevResult> {
	const repo = target();
	const dev = repo.dev;
	if (!dev) {
		return {
			healthy: false,
			port: 0,
			skippedReason: "No dev server configured",
		};
	}

	const port = dev.port;
	const healthPath = dev.healthPath;
	const timeoutMs = (dev.readyTimeoutSeconds ?? 120) * 1_000;

	const envEntries = Object.entries(dev.env ?? {})
		.map(([k, v]) => `${k}=${shellEscape(v)}`)
		.join(" ");
	const envPrefix = envEntries ? `${envEntries} ` : "";

	await sandbox.run(
		`cd ${shellEscape(repoDir)} && ${envPrefix}nohup ${dev.start} > /tmp/dev.log 2>&1 &`,
	);

	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		await sleep(2_000);
		const result = await sandbox.run(
			`curl -sf http://localhost:${port}${healthPath} > /dev/null 2>&1 && echo ok || echo fail`,
		);
		if (result.output.trim() === "ok") {
			return { healthy: true, port };
		}
	}

	const logTail = await sandbox.run(
		"tail -200 /tmp/dev.log 2>/dev/null || echo '(no log)'",
	);
	try {
		await putArtifact({
			runId,
			kind: "log",
			contentType: "text/plain",
			bytes: Buffer.from(logTail.output, "utf-8"),
		});
	} catch {
		/* artifact storage failure is non-fatal */
	}

	return {
		healthy: false,
		port,
		skippedReason: `Dev server did not become healthy within ${dev.readyTimeoutSeconds ?? 120}s. Log tail:\n${logTail.output.slice(-500)}`,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
