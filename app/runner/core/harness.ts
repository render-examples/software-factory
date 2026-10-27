import type { Emitter } from "./emit.js";
import type { RunnerInput, TestTurn } from "./protocol.js";

/** One agent run, as the runner hands it to the agent's harness. */
export interface HarnessRun {
	/** Already validated with parseInput. */
	input: RunnerInput;
	emit: Emitter;
	/** The key delivered on stdin; unused with `testScript`. */
	apiKey?: string;
	/** Set by `--test-stub`: these turns replace the model. */
	testScript?: TestTurn[];
	/** Epoch ms the `timeout_ms` budget is measured from. */
	startedAt: number;
	/** Aborting stops the run with `agent_error`. */
	signal?: AbortSignal;
}

export interface HarnessSelfTest {
	/** The agent library's version, as installed in this sandbox. */
	version: string;
	/** Problems that would stop it from running here; empty when it is ready. */
	problems: string[];
}

/**
 * The part of a harness the runner calls, inside the sandbox. What a harness must do, beyond these signatures,
 * is pinned by the conformance suite (tests/runner.test.ts): give the model only the factory's tools for
 * `input.tools` (app/runner/tools/) and a submit tool checked by `Submission`, emit `started` with the library
 * version and exact model, then exactly one `result` or `error`, and stop at `max_turns` and `timeout_ms`.
 */
export interface HarnessRuntime {
	readonly name: string;
	/** Runs one agent and returns the exit code. */
	run(run: HarnessRun): Promise<number>;
	selfTest(): Promise<HarnessSelfTest>;
}
