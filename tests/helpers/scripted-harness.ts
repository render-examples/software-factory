import type { DriverContext } from "../../app/runner/core/driver.js";
import type { Harness } from "../../app/harness/types.js";

/** One scripted model turn: optional text, then tool calls in order. A turn without calls ends the conversation. */
export interface TestTurn {
	text?: string;
	calls: { name: string; args: Record<string, unknown> }[];
}

/**
 * A driver with no agent library: each model request plays the next of `turns`. It stands in for a third-party
 * library in the conformance suite, proving a harness can be swapped without host or runner changes.
 */
export function scripted(turns: readonly TestTurn[]): Harness {
	return {
		name: "scripted",
		label: "scripted",
		credential: "SCRIPTED_API_KEY",
		driver: { open: (ctx) => ({ version: "1.0.0", model: "scripted", run: () => play(ctx, turns) }) },
	};
}

async function play(ctx: DriverContext, turns: readonly TestTurn[]): Promise<void> {
	const tools = new Map(ctx.tools.map((t) => [t.name as string, t]));
	let callId = 0;
	for (const turn of turns) {
		if (!ctx.requestModel()) return;
		if (turn.text) ctx.report.text(turn.text);
		if (turn.calls.length === 0) return;
		for (const call of turn.calls) {
			const id = `call-${++callId}`;
			ctx.report.toolCall(id, call.name, call.args);
			const tool = tools.get(call.name);
			const out =
				call.name === ctx.submit.name
					? ctx.submit.call(call.args)
					: tool
						? await tool.execute(call.args, ctx.signal)
						: { text: `Tool ${call.name} not found`, isError: true };
			ctx.report.toolResult(id, call.name, out.text, out.isError);
		}
	}
}
