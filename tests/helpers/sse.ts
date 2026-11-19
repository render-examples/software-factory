export interface SseFrame {
	event?: string;
	id?: string;
	data: unknown;
}

export function readSse(response: Response) {
	if (!response.body) throw new Error("response has no body");
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	return {
		async next(): Promise<SseFrame | null> {
			for (;;) {
				const end = buffer.indexOf("\n\n");
				if (end >= 0) {
					const raw = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					if (!raw.startsWith(":")) return parse(raw);
					continue;
				}
				const { value, done } = await reader.read();
				if (done) return null;
				buffer += value;
			}
		},
		async take(count: number): Promise<SseFrame[]> {
			const frames: SseFrame[] = [];
			while (frames.length < count) {
				const frame = await this.next();
				if (!frame) break;
				frames.push(frame);
			}
			return frames;
		},
		close: () => reader.cancel(),
	};
}

function parse(raw: string): SseFrame {
	const fields: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const colon = line.indexOf(": ");
		fields[line.slice(0, colon)] = line.slice(colon + 2);
	}
	return { event: fields.event, id: fields.id, data: fields.data === undefined ? undefined : JSON.parse(fields.data) };
}
