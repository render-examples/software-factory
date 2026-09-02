import { task } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../../factory.config.js";
import { type Agent, runClaude } from "../claude/index.js";
import { connectSandbox } from "../sandbox/index.js";

export interface AgentTaskInput {
	message: string;
	/** Supplied by workflow code, never by the model. */
	sandboxId?: string;
}

/**
 * Register an agent as a Render Workflows task.
 *
 * This is what makes each agent its own task run in the Render dashboard,
 * with its own instance plan and timeline — the review fan-out is visible on
 * the platform rather than hidden inside one process.
 */
export function agentTask(agent: Agent) {
	return task(
		{ name: agent.id, plan: agent.plan },
		async function runAgent(input: AgentTaskInput): Promise<string> {
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
