/**
 * Render Workflows entrypoint — configures the tool registry with sandbox
 * support (when credentials are available), then imports all tasks and
 * workflows to register them.
 */
import {
  configure,
  createRegistry,
  createSandboxToolSource,
  RenderSandboxProvider,
} from "../../sdk/index.js";
import { ClaudeBuiltInToolSource } from "../../sdk/runners/index.js";

const registry = createRegistry().register(new ClaudeBuiltInToolSource());

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

// Agent tasks
import "../tasks/index.js";

// Composition workflows
import "../workflows/spec-to-pr.js";
import "../workflows/pr-review.js";
import "../workflows/pr-fix.js";
import "../workflows/slack-assistant.js";

console.log("workflows host ready — tasks registered");
