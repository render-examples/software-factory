import type { LiveNotice } from "../events/index.js";

export type Delta = Extract<LiveNotice, { type: "delta" }>;

/** An assistant message still being streamed, with its text so far. */
export interface PartialMessage {
	stream: string;
	subject: string | null;
	message_id: string;
	text: string;
}

const STALE_MS = 15 * 60_000;

/**
 * The text so far of each in-progress assistant message. Every gateway instance receives every live notification,
 * so each builds the same cache without sharing memory.
 */
export class LiveCache {
	readonly #messages = new Map<string, PartialMessage & { localSeq: number; part: number; updated: number }>();

	/** Applies a notice; returns the delta to forward to subscribers, or null for a repeat or a final. */
	apply(notice: LiveNotice, now = Date.now()): Delta | null {
		const key = `${notice.stream} ${notice.message_id}`;
		if (notice.type === "final") {
			this.#messages.delete(key);
			return null;
		}
		const current = this.#messages.get(key);
		if (current && (notice.local_seq < current.localSeq || (notice.local_seq === current.localSeq && notice.part <= current.part))) return null;
		this.#messages.set(key, {
			stream: notice.stream,
			subject: notice.subject,
			message_id: notice.message_id,
			text: (current?.text ?? "") + notice.text,
			localSeq: notice.local_seq,
			part: notice.part,
			updated: now,
		});
		this.#sweep(now);
		return notice;
	}

	/** In-progress messages on a stream or a subject. */
	partials(key: string): PartialMessage[] {
		return [...this.#messages.values()]
			.filter((message) => message.stream === key || message.subject === key)
			.map(({ stream, subject, message_id, text }) => ({ stream, subject, message_id, text }));
	}

	/** Drops messages whose final was missed, e.g. while the listener was reconnecting. */
	#sweep(now: number): void {
		for (const [key, message] of this.#messages) if (now - message.updated > STALE_MS) this.#messages.delete(key);
	}
}
