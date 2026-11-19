import type { Driver } from "./driver.js";
import type { Emitter } from "./emit.js";
import type { RunnerInput } from "./protocol.js";

export interface HarnessRun {
	input: RunnerInput;
	emit: Emitter;
	apiKey: string;
	startedAt: number;
	signal?: AbortSignal;
}

export interface HarnessRuntime {
	readonly name: string;
	readonly driver: Driver;
}
