import { agentRunFinished, agentRunStarted, toolCall } from "../events/index.js";
import type { Projection } from "./projections.js";

const STREAM_PREFIX = "agent_run:";

export const agentRuns: Projection = {
	table: "agent_runs",
	key: ["id"],
	operational: [],
	async apply(tx, event) {
		if (!event.stream.startsWith(STREAM_PREFIX)) return;
		const id = event.stream.slice(STREAM_PREFIX.length);
		if (event.type === agentRunStarted.type) {
			const started = agentRunStarted.payload.parse(event.payload);
			await tx.query(
				`insert into agent_runs (id, run_id, thread, agent_id, model, state, started_at, updated_seq)
				 values ($1, $2, $3, $4, $5, 'running', $6, $7)`,
				[id, started.run_id, event.thread, started.agent_id, started.model, event.createdAt, event.seq],
			);
		} else if (event.type === toolCall.type) {
			await tx.query("update agent_runs set tool_calls = tool_calls + 1, updated_seq = $2 where id = $1", [id, event.seq]);
		} else if (event.type === agentRunFinished.type) {
			const finished = agentRunFinished.payload.parse(event.payload);
			await tx.query("update agent_runs set state = $2, turns = $3, usage = $4, cost_usd = $5, finished_at = $6, updated_seq = $7 where id = $1", [
				id,
				finished.outcome,
				finished.turns,
				JSON.stringify(finished.usage),
				finished.cost_usd,
				event.createdAt,
				event.seq,
			]);
		}
	},
};
