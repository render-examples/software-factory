import { beforeEach, describe, expect, it } from "vitest";
import {
	configureFactoryStore,
	createMemoryFactoryStore,
	type FactoryStore,
} from "#factory/store";
import {
	BLOB_THRESHOLD,
	delBlob,
	getBlob,
	isBlobRef,
	maybePutBlob,
	putBlob,
	requireBlob,
} from "../blobs.js";

let now: Date;
let store: FactoryStore;

beforeEach(async () => {
	now = new Date("2026-08-31T00:00:00.000Z");
	store = createMemoryFactoryStore({ now: () => now });
	configureFactoryStore(store);
	for (const runId of ["run1", "r1"]) {
		await store.runs.ensureRun({
			id: runId,
			rootRunId: runId,
			kind: "agent",
			name: "test",
		});
	}
});

describe("putBlob / getBlob", () => {
	it("stores content and returns an opaque $blob reference", async () => {
		const ref = await putBlob("run1", "researcher", "hello world");
		expect(ref).toMatch(/^\$blob:blob:run1:researcher:[a-f0-9]+$/);
		expect(await getBlob(ref)).toBe("hello world");
	});

	it("refreshes artifact lifetime when it is read", async () => {
		const ref = await putBlob("run1", "step", "data", 1);
		now = new Date(now.getTime() + 500);
		expect(await getBlob(ref)).toBe("data");
		now = new Date(now.getTime() + 2_000);
		expect(await getBlob(ref)).toBe("data");
	});

	it("returns null for unknown or foreign references", async () => {
		expect(await getBlob("$blob:blob:unknown:step:abc")).toBeNull();
		expect(await getBlob("$blob:thread:private")).toBeNull();
	});

	it("uses opaque capabilities instead of content-derived keys", async () => {
		const first = await putBlob("run1", "step", "same");
		const second = await putBlob("run1", "step", "same");
		expect(first).not.toBe(second);
		expect(isBlobRef(first)).toBe(true);
	});

	it("fails closed for an invalid or expired required reference", async () => {
		await expect(
			requireBlob("$blob:blob:unknown:step:abc"),
		).rejects.toThrow(/invalid or expired/);
	});
});

describe("delBlob", () => {
	it("deletes a stored blob", async () => {
		const ref = await putBlob("run1", "step", "to-delete");
		expect(await getBlob(ref)).toBe("to-delete");
		await delBlob(ref);
		expect(await getBlob(ref)).toBeNull();
	});
});

describe("maybePutBlob", () => {
	it("returns content inline up to the threshold", async () => {
		const small = "x".repeat(BLOB_THRESHOLD - 1);
		const exact = "x".repeat(BLOB_THRESHOLD);
		expect(await maybePutBlob("r1", "step", small)).toBe(small);
		expect(await maybePutBlob("r1", "step", exact)).toBe(exact);
	});

	it("stores and returns a reference above the threshold", async () => {
		const large = "x".repeat(BLOB_THRESHOLD + 1);
		const result = await maybePutBlob("r1", "step", large);
		expect(result).toMatch(/^\$blob:/);
		expect(await getBlob(result)).toBe(large);
	});
});
