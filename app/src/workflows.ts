/** Render Workflows entrypoint — tool registry setup + task/workflow imports. */
import { closeKv, configure } from "#factory/sdk";
import { auditHook } from "../hooks/audit.js";
import { blockDestructiveHook } from "../hooks/block-destructive.js";
import { redactSecretsHook } from "../hooks/redact-secrets.js";
import { assertWorkflowConfig } from "../lib/factory-config.js";
import { createWorkflowRegistry } from "../lib/workflow-registry.js";

assertWorkflowConfig();

configure({
	registry: createWorkflowRegistry(),
	hooks: [auditHook, blockDestructiveHook, redactSecretsHook],
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void closeKv().finally(() => process.exit(0));
	});
}

import "../tasks/index.js";
import "../workflows/slack-assistant.js";
import "../workflows/spec-to-pr.js";

console.log("single-repository factory workflows ready");
