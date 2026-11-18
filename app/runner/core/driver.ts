import type { FactoryTool } from "../tools/index.js";
import type { Usage } from "./protocol.js";

export interface Driver {
	open(ctx: DriverContext): DriverSession | Promise<DriverSession>;
}

export interface DriverSession {
	readonly version: string;
	readonly model: string;
	run(): Promise<void>;
}

export interface DriverContext {
	readonly systemPrompt: string;
	readonly message: string;
	readonly apiKey: string;
	readonly cwd: string;
	readonly scratchDir: string;
	readonly tools: readonly FactoryTool[];
	readonly submit: SubmitTool;
	readonly signal: AbortSignal;
	requestModel(): boolean;
	readonly report: Report;
}

export interface SubmitTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	call(args: unknown): { text: string; isError: boolean };
}

export interface Report {
	delta(messageId: string, text: string): void;
	text(messageId: string, text: string): void;
	usage(usage: Usage): void;
	toolCall(id: string, tool: string, args: unknown): void;
	toolResult(id: string, tool: string, text: string, isError: boolean): void;
}

export class InvalidInput extends Error {
	override readonly name = "InvalidInput";
}
