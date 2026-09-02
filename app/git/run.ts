import { factoryConfig } from "../../factory.config.js";
import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";

export const REPO_DIR = factoryConfig.repoDir;

/** Run a git subcommand in the checkout. Disables repo hooks for safety. */
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
