import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";

const LOCKFILE_NAMES = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
] as const;

/**
 * Compute the SHA-256 of whichever lockfile exists in the checkout,
 * using sha256sum inside the sandbox so large files are never
 * transferred or truncated.
 */
export async function lockfileHashInSandbox(
	sandbox: Sandbox,
	dir: string,
): Promise<string> {
	for (const name of LOCKFILE_NAMES) {
		const path = `${dir}/${name}`;
		const result = await sandbox.run(
			`sha256sum ${shellEscape(path)} 2>/dev/null`,
		);
		if (result.exitCode === 0 && result.output.length > 0) {
			const hash = result.output.trim().split(/\s+/)[0];
			if (hash && /^[0-9a-f]{64}$/.test(hash)) {
				return hash;
			}
		}
	}
	return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
}
