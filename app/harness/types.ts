import type { HarnessRuntime } from "../runner/core/harness.js";

/**
 * What an adapter returns: the runtime the runner calls in the sandbox, plus what the host needs to know before a
 * run. Build one with an adapter from this directory and give it to an agent definition.
 */
export interface Harness extends HarnessRuntime {
	/** Names the library and model in setup, doctor, and logs before a run. The runner reports the exact model in `started`. */
	readonly label: string;
	/**
	 * The env var on the Workflows service that holds this harness's key. The host sends its value into the sandbox
	 * for each run; setup and doctor manage it.
	 */
	readonly credential: string;
	/** Sandbox setup that app/sandbox/ applies at snapshot build and when a sandbox opens. Called on the host only. */
	readonly provision?: () => HarnessProvision;
}

/**
 * A harness's sandbox setup. The host ships `files` with the runner bundle, root-owned and read-only to the runner
 * user, and runs `command` as root whenever `hash` differs from the one the sandbox recorded: at snapshot build and
 * when a sandbox opens, before the runner self-tests. The sandbox code runs it without knowing what it installs.
 */
export interface HarnessProvision {
	/** Names this setup in logs and in the sandbox's record of applied setups; [a-z0-9-]. */
	id: string;
	/** Host files to ship; `path` is relative to the bundle's directory (APP_DIR/runner/). */
	files: ReadonlyArray<{ path: string; source: string }>;
	/**
	 * Bash run as root from the bundle's directory after the files land. It must leave whatever it creates root-owned
	 * and not writable by the runner user.
	 */
	command?: string;
	/** Changes exactly when `command` must run again, e.g. a hash of the dependency lockfile. */
	hash: string;
}
