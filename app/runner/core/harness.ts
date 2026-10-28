import type { Driver } from "./driver.js";
import type { Emitter } from "./emit.js";
import type { RunnerInput } from "./protocol.js";

/** One agent run, as the runner hands it to the kernel. */
export interface HarnessRun {
	/** Already validated with parseInput. */
	input: RunnerInput;
	emit: Emitter;
	/** The key delivered on stdin. */
	apiKey: string;
	/** Epoch ms the `timeout_ms` budget is measured from. */
	startedAt: number;
	/** Aborting stops the run with `agent_error`. */
	signal?: AbortSignal;
}

/** What the runner runs inside the sandbox: the kernel (`executeHarness`) drives the agent library through `driver`. */
export interface HarnessRuntime {
	readonly name: string;
	readonly driver: Driver;
}
