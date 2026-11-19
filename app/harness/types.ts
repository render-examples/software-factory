import type { HarnessRuntime } from "../runner/index.js";

export interface Harness extends HarnessRuntime {
	readonly label: string;
	readonly credential: string;
	readonly egress: readonly string[];
}
