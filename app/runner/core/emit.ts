import type { RunnerEvent } from "./protocol.js";

type WithoutAt<E> = E extends unknown ? Omit<E, "at"> : never;
export type EventBody = WithoutAt<RunnerEvent>;

export interface Emitter {
	(event: EventBody): void;
	readonly terminated: boolean;
	/** Replaces `secret` with `[REDACTED]` in every later line. */
	redact(secret: string): void;
	/** Resolves once every line written so far has been flushed. */
	flush(): Promise<void>;
}

/**
 * Writes one RunnerEvent per line, in 7-bit ASCII (see `asciiJson`). Drops everything after the first terminal
 * (`result`/`error`) event.
 */
export function createEmitter(write: (chunk: string) => Promise<void>): Emitter {
	const secrets: string[] = [];
	let pending = Promise.resolve();
	let terminated = false;
	const emit = (event: EventBody) => {
		if (terminated) return;
		terminated = event.type === "result" || event.type === "error";
		const { type, ...fields } = event;
		let line = JSON.stringify({ type, at: new Date().toISOString(), ...fields });
		for (const secret of secrets) line = line.replaceAll(secret, "[REDACTED]");
		line = asciiJson(line);
		pending = pending.then(() => write(`${line}\n`)).catch(() => {});
	};
	// defineProperty, not Object.assign: assign would copy the getter's value once instead of the getter.
	Object.defineProperty(emit, "terminated", { get: () => terminated });
	return Object.assign(emit as typeof emit & { readonly terminated: boolean }, {
		redact(secret: string) {
			if (secret) secrets.push(secret);
		},
		flush: () => pending,
	});
}

/**
 * `json` with every non-ASCII UTF-16 code unit escaped as `\uXXXX`, which `JSON.parse` reads back as the same
 * string. The host receives the runner's output as decoded text in arbitrary chunks and counts its bytes to resume
 * from `<runDir>.jsonl`; in ASCII, no chunk boundary can split a character, and characters and bytes agree.
 */
export const asciiJson = (json: string): string => json.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const PREVIEW_CHARS = 2000;
const TRUNCATED = "…[truncated]";

/** A tool result's text as it appears in `tool_result.output_preview`. */
export function previewText(text: string): string {
	return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS - TRUNCATED.length) + TRUNCATED : text;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
