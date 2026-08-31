import {
  createRegistry,
  createSandboxToolSource,
  RenderSandboxProvider,
  type SandboxProvider,
  type ToolRegistry,
} from "#factory/sdk";
import { SlackAssistantGitHubToolSource } from "../tools/slack-assistant.js";
import { SlackAssistantRenderToolSource } from "../tools/render-read.js";

/** Build the production tool surface: one workflow-bound sandbox source. */
export function createWorkflowRegistry(
  provider: SandboxProvider = new RenderSandboxProvider(),
): ToolRegistry {
  return createRegistry()
    .register(createSandboxToolSource({ provider }))
    .register(new SlackAssistantGitHubToolSource())
    .register(new SlackAssistantRenderToolSource());
}
