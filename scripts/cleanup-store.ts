import { createPostgresFactoryStore } from "#factory/store";

const store = createPostgresFactoryStore({
	applicationName: "render-factory-retention",
	max: 1,
});
try {
	await store.verifySchema();
	const result = await store.cleanup({
		eventRetentionDays: envDays("FACTORY_EVENT_RETENTION_DAYS", 30),
		runRetentionDays: envDays("FACTORY_RUN_RETENTION_DAYS", 90),
		batchSize: 500,
	});
	console.log(JSON.stringify({ event: "factory_store_cleanup", ...result }));
} finally {
	await store.close();
}

function envDays(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > 3_650) {
		throw new Error(`${name} must be an integer from 1 to 3650`);
	}
	return value;
}
