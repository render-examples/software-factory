import { beforeEach, describe, expect, it } from "vitest";
import {
	configureFactoryStore,
	createMemoryFactoryStore,
} from "#factory/store";
import {
	appendConventions,
	getConventions,
	putConventions,
} from "../lib/convention-memory.js";

beforeEach(() => {
	configureFactoryStore(createMemoryFactoryStore());
});

describe("convention memory", () => {
	it("stores and retrieves conventions", async () => {
		await putConventions("acme/app", "Uses Vitest for testing");
		expect(await getConventions("acme/app")).toBe("Uses Vitest for testing");
	});

	it("returns null for unknown repositories", async () => {
		expect(await getConventions("acme/unknown")).toBeNull();
	});

	it("truncates conventions to the character limit", async () => {
		await putConventions("acme/app", "x".repeat(5_000));
		expect(await getConventions("acme/app")).toHaveLength(2_000);
	});

	it("appends new conventions without duplicates", async () => {
		await putConventions("acme/app", "Uses Vitest\nUses TypeScript");
		await appendConventions("acme/app", "Uses ESM\nUses Vitest");
		const result = await getConventions("acme/app");
		expect(result).toContain("Uses Vitest");
		expect(result).toContain("Uses TypeScript");
		expect(result).toContain("Uses ESM");
		expect(
			(result?.split("\n") ?? []).filter((line) => line === "Uses Vitest"),
		).toHaveLength(1);
	});

	it("creates conventions on first append", async () => {
		await appendConventions("acme/new-repo", "Uses React\nUses Next.js");
		expect(await getConventions("acme/new-repo")).toBe(
			"Uses React\nUses Next.js",
		);
	});

	it("keeps content stable when all conventions already exist", async () => {
		await putConventions("acme/app", "Uses Vitest\nUses TypeScript");
		await appendConventions("acme/app", "Uses Vitest\nUses TypeScript");
		expect(await getConventions("acme/app")).toBe(
			"Uses Vitest\nUses TypeScript",
		);
	});
});
