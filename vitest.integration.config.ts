import { defineConfig } from "vitest/config";

/** Postgres-backed suites. They require DATABASE_URL and run one file at a time. */
export default defineConfig({
	test: {
		include: ["tests/integration/**/*.test.ts"],
		fileParallelism: false,
		passWithNoTests: true,
	},
});
