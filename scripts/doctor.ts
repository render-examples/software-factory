import { TaskRegistry } from "@renderinc/sdk/workflows";
import { createPostgresFactoryStore } from "#factory/store";
import {
	assertGatewayConfig,
	assertWorkflowConfig,
	factoryRepository,
} from "../app/lib/factory-config.js";
import { createWorkflowRegistry } from "../app/lib/workflow-registry.js";

function requireConfiguration(): void {
	assertGatewayConfig();
	assertWorkflowConfig();
	if ((process.env.GITHUB_WEBHOOK_SECRET ?? "").length < 32) {
		throw new Error("GITHUB_WEBHOOK_SECRET must be at least 32 characters");
	}
}

async function checkGitHub(): Promise<void> {
	const repository = factoryRepository();
	const response = await fetch(
		`https://api.github.com/repos/${repository.owner}/${repository.repo}`,
		{
			headers: {
				Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "render-factory-doctor",
			},
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			`GITHUB_TOKEN cannot access FACTORY_REPO (HTTP ${response.status})`,
		);
	}
	await response.body?.cancel();
}

async function checkWorkflowRegistration(): Promise<void> {
	await import("../app/tasks/index.js");
	await import("../app/workflows/index.js");
	const registered = new Set(TaskRegistry.getInstance().getAllTaskNames());
	const expected = [
		"analyst",
		"correctness",
		"implementer",
		"judge",
		"security",
		"self-review",
		"spec-to-pr",
		"tests",
		"triage",
	];
	const missing = expected.filter((name) => !registered.has(name));
	if (missing.length > 0) {
		throw new Error(`Workflow tasks did not register: ${missing.join(", ")}`);
	}
	const sources = createWorkflowRegistry().sourceIds();
	if (sources.join(",") !== "sandbox") {
		throw new Error(
			"Production tool registry does not match the bounded surface",
		);
	}
}

async function main(): Promise<void> {
	requireConfiguration();
	console.log("✓ configuration is complete");
	const store = createPostgresFactoryStore({
		applicationName: "render-factory-doctor",
	});
	try {
		await Promise.all([
			checkGitHub(),
			store.health(),
			checkWorkflowRegistration(),
		]);
		await store.verifySchema();
		console.log("✓ GITHUB_TOKEN can access FACTORY_REPO");
		console.log("✓ DATABASE_URL accepts Postgres queries");
		console.log("✓ factory store schema is current");
		console.log("✓ workflow tasks and bounded tools register locally");
		console.log(
			"✓ local checks passed; confirm the Dashboard Workflow slug matches RENDER_WORKFLOW_SLUG",
		);
	} finally {
		await store.close().catch(() => {});
	}
}

main()
	.catch((error) => {
		console.error(`Factory doctor failed: ${String(error)}`);
		process.exitCode = 1;
	});
