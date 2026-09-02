import { factoryConfig } from "../../factory.config.js";
import { type Sandbox, shellEscape } from "../sandbox/index.js";

export const REPO_DIR = factoryConfig.repoDir;

/**
 * Run a git subcommand in the checkout, throwing on failure.
 *
 * `core.hooksPath=/dev/null` disables repository hooks: the factory clones
 * untrusted repositories, and a checked-in hook must not run as us.
 */
export function git(
	sandbox: Sandbox,
	subcommand: string,
	label: string,
): Promise<string> {
	return sandbox.mustRun(
		`git -c core.hooksPath=/dev/null -C ${shellEscape(REPO_DIR)} ${subcommand}`,
		label,
	);
}
