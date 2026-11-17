import { defineConfig } from "vitest/config";

const POSTGRES_TESTS = "tests/**/*-postgres.test.ts";

export default defineConfig({
	test: {
		setupFiles: ["tests/setup.ts"],
		projects: [
			{ extends: true, test: { name: "unit", include: ["tests/**/*.test.ts"], exclude: [POSTGRES_TESTS] } },
			// One file at a time: a transaction running anywhere on the server holds back every subject reader's watermark.
			{ extends: true, test: { name: "postgres", include: [POSTGRES_TESTS], fileParallelism: false } },
		],
	},
});
