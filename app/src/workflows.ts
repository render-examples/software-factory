/** Render Workflows entrypoint — tool registry setup + task/workflow imports. */
import {
  configure,
  createRegistry,
  createSandboxToolSource,
  RenderSandboxProvider,
} from "../../sdk/index.js";
import { ClaudeBuiltInToolSource } from "../../sdk/runners/index.js";
import { TriggerWorkflowToolSource } from "../tools/trigger-workflow.js";

const registry = createRegistry()
  .register(new ClaudeBuiltInToolSource())
  .register(new TriggerWorkflowToolSource());

if (process.env.RENDER_API_KEY) {
  registry.register(
    createSandboxToolSource({
      provider: new RenderSandboxProvider(),
    }),
  );
  console.log("sandbox tools registered (RENDER_API_KEY present)");
} else {
  console.log("sandbox tools skipped (no RENDER_API_KEY)");
}

configure({ registry });

import "../tasks/index.js";
import "../workflows/spec-to-pr.js";
import "../workflows/pr-review.js";
import "../workflows/pr-fix.js";
import "../workflows/slack-assistant.js";

console.log("workflows host ready — tasks registered");
