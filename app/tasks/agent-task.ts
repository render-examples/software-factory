import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../../factory.config.js";
import { type Agent, runClaude } from "../claude/index.js";
import { connectSandbox } from "../sandbox/index.js";

export interface AgentTaskInput {
	message: string;
	sandboxId?: string;
}

/** Turn an Agent into a Render Workflows task. */
export function agentTask(agent: Agent) {
	return task(
		{ name: agent.id, plan: agent.plan },
		async function runAgent(
			_ctx: TaskContext,
			input: AgentTaskInput,
		): Promise<string> {
			const run = await runClaude({
				agentId: agent.id,
				systemPrompt: agent.prompt,
				prompt: input.message,
				model: factoryConfig.models[agent.model],
				maxTurns: agent.maxTurns,
				tools: agent.tools,
				sandbox: input.sandboxId ? connectSandbox(input.sandboxId) : undefined,
			});

			console.log(
				JSON.stringify({
					event: "agent_completed",
					agent: agent.id,
					model: factoryConfig.models[agent.model],
					inputTokens: run.inputTokens,
					outputTokens: run.outputTokens,
				}),
			);
			return run.result;
		},
	);
}
