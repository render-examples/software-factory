import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMemoryFactoryStore,
	type FactoryStore,
} from "#factory/store";
import { createApp } from "../gateway/server.js";

let store: FactoryStore;

beforeEach(() => {
	store = createMemoryFactoryStore();
	process.env.FACTORY_REPO = "acme/factory";
	process.env.FACTORY_GITHUB_ACTORS = "maintainer";
});

afterEach(async () => {
	vi.restoreAllMocks();
	await store.close();
	delete process.env.FACTORY_REPO;
	delete process.env.FACTORY_GITHUB_ACTORS;
});

describe("factory gateway", () => {
	it("reports health", async () => {
		const response = await createApp({ store }).request("/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("reports store readiness separately", async () => {
		const app = createApp({ store });
		expect((await app.request("/ready")).status).toBe(200);

		vi.spyOn(store, "health").mockRejectedValue(new Error("offline"));
		const unavailable = await app.request("/ready");
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toEqual({ status: "unavailable" });
	});

	it("does not expose removed surfaces", async () => {
		const app = createApp({ store });
		expect(
			(await app.request("/threads/t1/messages", { method: "POST" })).status,
		).toBe(404);
	});
});
