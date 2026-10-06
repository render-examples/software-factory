import { target } from "../config/index.js";
import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";

export const REPO_DIR = target().repoDir;

const GIT_IDENTITY_NAME = "render-factory[bot]";
const GIT_IDENTITY_EMAIL = "bot@render-factory.dev";

/** Hardened git env that blocks global/system config and fsmonitor. */
const HARDENED_ENV = [
	"GIT_CONFIG_GLOBAL=/dev/null",
	"GIT_CONFIG_SYSTEM=/dev/null",
].join(" ");

/** Config flags applied to every git invocation. */
function hardenedFlags(): string {
	return [
		"-c core.hooksPath=/dev/null",
		"-c core.fsmonitor=false",
		`-c user.name=${shellEscape(GIT_IDENTITY_NAME)}`,
		`-c user.email=${shellEscape(GIT_IDENTITY_EMAIL)}`,
	].join(" ");
}

/** Run a git subcommand in the checkout with hardened config. */
export function git(
	sandbox: Sandbox,
	subcommand: string,
	label: string,
): Promise<string> {
	return sandbox.mustRun(
		`${HARDENED_ENV} git ${hardenedFlags()} -C ${shellEscape(REPO_DIR)} ${subcommand}`,
		label,
	);
}

/** Run git and return the ExecResult instead of throwing on non-zero. */
export function gitRun(sandbox: Sandbox, subcommand: string) {
	return sandbox.run(
		`${HARDENED_ENV} git ${hardenedFlags()} -C ${shellEscape(REPO_DIR)} ${subcommand}`,
	);
}
