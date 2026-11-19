import type { runAgent } from "../../app/agent-runs/index.js";

export type AgentStep = { output: unknown } | Error | (() => Promise<unknown>);

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

export function fakeAgents(steps: Record<string, AgentStep[]>) {
	const calls: Array<{ agent: string; message: string }> = [];
	const run = (async (agent: { id: string }, message: string) => {
		calls.push({ agent: agent.id, message });
		const step = steps[agent.id]?.shift();
		if (!step) throw new Error(`unexpected call to ${agent.id}`);
		if (step instanceof Error) throw step;
		const output = typeof step === "function" ? await step() : step.output;
		return { output, usage: USAGE, costUsd: 0, turns: 1 };
	}) as unknown as typeof runAgent;
	return { run, calls };
}
