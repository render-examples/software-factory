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
}
