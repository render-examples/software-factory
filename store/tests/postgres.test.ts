import { createPostgresFactoryStore } from "../postgres/index.js";
import { runFactoryStoreConformance } from "./conformance.js";

const enabled = process.env.RUN_LIVE_INTEGRATION === "1";
if (enabled && !process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL is required for live integration tests");
}

runFactoryStoreConformance(
	"postgres",
	async () => {
		const store = createPostgresFactoryStore({
			applicationName: "render-factory-conformance",
			max: 2,
		});
		await store.migrate();
		return store;
	},
	{ skip: !enabled },
);
