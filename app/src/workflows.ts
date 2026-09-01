/** Render Workflows entrypoint — sandbox provider + hook setup, then task/workflow imports. */
import {
	configureFactoryStore,
	createPostgresFactoryStore,
} from "#factory/store";
import {
	configure,
	configureSandboxProvider,
	RenderSandboxProvider,
} from "#factory/sdk";
import { auditHook } from "../hooks/audit.js";
import { blockDestructiveHook } from "../hooks/block-destructive.js";
import { costTrackingHook } from "../hooks/cost-tracking.js";
import { redactSecretsHook } from "../hooks/redact-secrets.js";
import { assertWorkflowConfig } from "../lib/factory-config.js";

assertWorkflowConfig();

const store = createPostgresFactoryStore({
	applicationName: "render-factory-workflows",
});
await store.verifySchema();
configureFactoryStore(store);

configureSandboxProvider(new RenderSandboxProvider());

configure({
	hooks: [auditHook, blockDestructiveHook, costTrackingHook, redactSecretsHook],
	store,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void store.close().finally(() => process.exit(0));
	});
}

await import("../tasks/index.js");
await import("../workflows/index.js");

console.log("single-repository factory workflows ready");
