import type { LiveNotice } from "../events/index.js";
import type { ThreadKey } from "../threads/index.js";

export type Delta = Extract<LiveNotice, { type: "delta" }>;

export interface PartialMessage {
	stream: string;
	thread: ThreadKey | null;
	message_id: string;
	text: string;
}

const STALE_MS = 15 * 60_000;

export class LiveCache {
	readonly #messages = new Map<string, PartialMessage & { localSeq: number; part: number; updated: number }>();

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
			thread: notice.thread,
			message_id: notice.message_id,
			text: (current?.text ?? "") + notice.text,
			localSeq: notice.local_seq,
			part: notice.part,
			updated: now,
		});
		this.#sweep(now);
		return notice;
	}

	partials(key: string): PartialMessage[] {
		return [...this.#messages.values()]
			.filter((message) => message.stream === key || message.thread === key)
			.map(({ stream, thread, message_id, text }) => ({ stream, thread, message_id, text }));
	}

	#sweep(now: number): void {
		for (const [key, message] of this.#messages) if (now - message.updated > STALE_MS) this.#messages.delete(key);
	}
}
