import type { RunnerEvent } from "./protocol.js";

type WithoutAt<E> = E extends unknown ? Omit<E, "at"> : never;
export type EventBody = WithoutAt<RunnerEvent>;

export interface Emitter {
	(event: EventBody): void;
	readonly terminated: boolean;
	redact(secret: string): void;
	flush(): Promise<void>;
}

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
	Object.defineProperty(emit, "terminated", { get: () => terminated });
	return Object.assign(emit as typeof emit & { readonly terminated: boolean }, {
		redact(secret: string) {
			if (secret) secrets.push(secret);
		},
		flush: () => pending,
	});
}

export const asciiJson = (json: string): string => json.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const PREVIEW_CHARS = 2000;
const TRUNCATED = "…[truncated]";

export function previewText(text: string): string {
	return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS - TRUNCATED.length) + TRUNCATED : text;
}
