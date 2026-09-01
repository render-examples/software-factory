import {
  createRegistry,
  createSandboxToolSource,
  RenderSandboxProvider,
  type SandboxProvider,
  type ToolRegistry,
} from "#factory/sdk";

/** Build the production tool surface: one workflow-bound sandbox source. */
export function createWorkflowRegistry(
  provider: SandboxProvider = new RenderSandboxProvider(),
): ToolRegistry {
  return createRegistry()
    .register(createSandboxToolSource({ provider }));
}
