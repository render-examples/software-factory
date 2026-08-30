/** Render Workflows entrypoint — tool registry setup + task/workflow imports. */
import {
  configure,
  createRegistry,
  createSandboxToolSource,
  RenderSandboxProvider,
  ClaudeBuiltInToolSource,
} from "#factory-sdk";
import { TriggerWorkflowToolSource } from "../tools/trigger-workflow.js";
import { GitHubToolSource } from "../tools/github.js";

const registry = createRegistry()
  .register(new ClaudeBuiltInToolSource())
  .register(new TriggerWorkflowToolSource())
  .register(new GitHubToolSource());

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
