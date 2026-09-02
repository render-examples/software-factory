import type { ExecEvent, ExecResult } from "./types.js";

const MAX_COLLECT_CHARS = 1_000_000;

/** Quote a string for safe use as a single shell argument. */
export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Drain an exec stream into one string. Output is capped at 1 MB. */
export async function collectExecOutput(
	events: AsyncGenerator<ExecEvent>,
): Promise<ExecResult> {
	const chunks: string[] = [];
	let total = 0;
	let exitCode = -1;

	for await (const event of events) {
		if (event.type === "exit") {
			exitCode = event.exitCode;
		} else if (total < MAX_COLLECT_CHARS) {
			const chunk = event.data.slice(0, MAX_COLLECT_CHARS - total);
			chunks.push(chunk);
			total += chunk.length;
		}
	}

	return { output: chunks.join(""), exitCode };
}

/** Normalize the Render SDK's snake_case exec stream into ExecEvent. */
export async function* mapExecEvents(
	source: AsyncGenerator<{
		type: string;
		stream?: string;
		data?: string;
		exit_code?: number;
	}>,
): AsyncGenerator<ExecEvent> {
	for await (const event of source) {
		if (event.type === "output") {
			yield {
				type: "output",
				stream: (event.stream as "stdout" | "stderr") ?? "stdout",
				data: event.data ?? "",
			};
		} else if (event.type === "exit") {
			yield { type: "exit", exitCode: event.exit_code ?? 1 };
		}
	}
}
