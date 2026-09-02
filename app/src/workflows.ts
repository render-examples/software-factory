/** Render Workflows entrypoint — sandbox provider + hook setup, then task/workflow imports. */
import {
	configureFactoryStore,
	createPostgresFactoryStore,
} from "#factory/store";
import {
	ClaudeRunner,
	configure,
	createClaudeModelResolver,
	RenderSandboxProvider,
} from "#factory/sdk";
import { factoryConfig } from "../../factory.config.js";
import {
	auditHook,
	blockDestructiveHook,
	costTrackingHook,
	redactSecretsHook,
} from "../hooks/index.js";
import { assertWorkflowConfig } from "../lib/index.js";

assertWorkflowConfig();

const store = createPostgresFactoryStore({
	applicationName: "render-factory-workflows",
});
await store.verifySchema();
configureFactoryStore(store);

const modelResolver = createClaudeModelResolver(factoryConfig.models);

configure({
	runner: new ClaudeRunner({ modelResolver }),
	hooks: [auditHook, blockDestructiveHook, costTrackingHook, redactSecretsHook],
	store,
	sandboxProvider: new RenderSandboxProvider(),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void store.close().finally(() => process.exit(0));
	});
}

await import("../tasks/index.js");
await import("../workflows/index.js");

console.log("single-repository factory workflows ready");
