import type { FactoryTool } from "../tools/index.js";
import type { Usage } from "./protocol.js";

/**
 * Puts an agent library behind the kernel (`executeHarness`). A driver only translates: the kernel owns the
 * run's lifecycle, its limits, the tools, the submission, and every protocol event.
 */
export interface Driver {
	/**
	 * Prepares the library for this run and resolves what will run, before `started`. Throw InvalidInput for a
	 * configuration the library can't run.
	 */
	open(ctx: DriverContext): DriverSession | Promise<DriverSession>;
}

export interface DriverSession {
	/** The library's version, reported in `started`. */
	readonly version: string;
	/** The exact model, reported in `started`. */
	readonly model: string;
	/**
	 * Converses with the model. Resolves when the model stops on its own and rejects with the reason when the
	 * library fails. Once the kernel has ended the run, how this settles no longer matters.
	 */
	run(): Promise<void>;
}

export interface DriverContext {
	readonly systemPrompt: string;
	readonly message: string;
	readonly apiKey: string;
	/** The library's working directory: the checkout, or `scratchDir` for an agent without tools. */
	readonly cwd: string;
	/** The only writable location besides `cwd`. */
	readonly scratchDir: string;
	/** Every tool the model may call besides `submit`. */
	readonly tools: readonly FactoryTool[];
	readonly submit: SubmitTool;
	/** Aborted when the run ends: stop the model and any running tool. */
	readonly signal: AbortSignal;
	/** Call immediately before each model request. False means the run is over: don't send it. */
	requestModel(): boolean;
	readonly report: Report;
}

/** The model's final answer. Every call returns the text for the model; the kernel records the outcome. */
export interface SubmitTool {
	readonly name: string;
	readonly description: string;
	/** JSON Schema of the arguments: the agent's output schema. */
	readonly parameters: Record<string, unknown>;
	/** Checks the model's arguments as it sent them, before any library validation or coercion. Never throws. */
	call(args: unknown): { text: string; isError: boolean };
}

/** What the library observed, for the event stream. */
export interface Report {
	text(text: string): void;
	usage(usage: Usage): void;
	toolCall(id: string, tool: string, args: unknown): void;
	/** Ignored unless `toolCall` announced `id`; the kernel truncates `text`. */
	toolResult(id: string, tool: string, text: string, isError: boolean): void;
}

/** A configuration the driver can't run, e.g. an unknown model: the run fails with `invalid_input`. */
export class InvalidInput extends Error {
	override readonly name = "InvalidInput";
}
