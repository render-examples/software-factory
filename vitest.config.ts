import { defineConfig } from "vitest/config";

const POSTGRES_TESTS = "tests/**/*-postgres.test.ts";

export default defineConfig({
	test: {
		setupFiles: ["tests/setup.ts"],
		projects: [
			{ extends: true, test: { name: "unit", include: ["tests/**/*.test.ts"], exclude: [POSTGRES_TESTS] } },
			{ extends: true, test: { name: "postgres", include: [POSTGRES_TESTS], fileParallelism: false } },
		],
	},
});
