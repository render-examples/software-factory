import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	values: new Map<string, string>(),
	expires: vi.fn(),
}));

vi.mock("../../sdk/redis.js", () => ({
	kv: async () => ({
		get: async (key: string) => state.values.get(key) ?? null,
		set: async (key: string, value: string, options?: { NX?: boolean }) => {
			if (options?.NX && state.values.has(key)) return null;
			state.values.set(key, value);
			return "OK";
		},
		del: async (key: string) => Number(state.values.delete(key)),
		expire: state.expires,
		eval: async (
			script: string,
			options: { keys: string[]; arguments: string[] },
		) => {
			const [firstKey, secondKey] = options.keys;
			const [attemptId, mode] = options.arguments;
			if (script.includes('return "claimed"')) {
				const delivery = state.values.get(firstKey);
				if (delivery?.startsWith("completed:")) return "completed";
				if (delivery?.startsWith("dispatched:")) return "dispatched";
				if (delivery) return "pending";
				if (state.values.has(secondKey)) return "busy";
				state.values.set(firstKey, `pending:${attemptId}`);
				state.values.set(secondKey, attemptId);
				return "claimed";
			}
			if (script.includes("local expected")) {
				if (state.values.get(firstKey) !== `pending:${attemptId}`) return 0;
				state.values.set(firstKey, `dispatched:${attemptId}`);
				return 1;
			}
			if (script.includes('ARGV[2] == "delete"')) {
				if (state.values.get(secondKey) === attemptId) {
					state.values.delete(secondKey);
				}
				const delivery = state.values.get(firstKey);
				if (mode === "delete" && delivery?.endsWith(attemptId)) {
					state.values.delete(firstKey);
				} else if (mode === "complete" && delivery?.endsWith(attemptId)) {
					state.values.set(firstKey, `completed:${attemptId}`);
				}
				return 1;
			}
			if (script.includes('redis.call("INCR"')) {
				const count = Number(state.values.get(firstKey) ?? "0") + 1;
				state.values.set(firstKey, String(count));
				return count;
			}
			if (script.includes('redis.call("EXPIRE"')) {
				if (state.values.get(firstKey) !== attemptId) return 0;
				state.expires(firstKey, Number(mode));
				return 1;
			}
			if (state.values.get(firstKey) === attemptId) {
				state.values.delete(firstKey);
				return 1;
			}
			return 0;
		},
	}),
}));

import {
	abandonIntake,
	claimExecution,
	claimIntake,
	completeIntake,
	getCheckpoint,
	incrementFailureCount,
	markIntakeDispatched,
	putCheckpoint,
	refreshExecution,
	refreshIntakeLease,
	releaseExecution,
} from "../lib/run-store.js";

const REPO = "acme/factory";
const ATTEMPT = "delivery-123456";

beforeEach(() => {
	state.values.clear();
	state.expires.mockReset().mockResolvedValue(1);
});

describe("factory run store", () => {
	it("atomically deduplicates deliveries and leases issues", async () => {
		expect(await claimIntake(REPO, 42, ATTEMPT)).toBe("claimed");
		expect(await claimIntake(REPO, 42, ATTEMPT)).toBe("pending");
		await markIntakeDispatched(REPO, ATTEMPT);
		expect(await claimIntake(REPO, 42, ATTEMPT)).toBe("dispatched");
		expect(await claimIntake(REPO, 42, "delivery-654321")).toBe("busy");
	});

	it("abandons failed dispatches but retains completed delivery dedupe", async () => {
		await claimIntake(REPO, 42, ATTEMPT);
		await abandonIntake(REPO, 42, ATTEMPT);
		expect(await claimIntake(REPO, 42, ATTEMPT)).toBe("claimed");

		await completeIntake(REPO, 42, ATTEMPT);
		expect(await claimIntake(REPO, 42, ATTEMPT)).toBe("completed");
		expect(await claimIntake(REPO, 42, "delivery-654321")).toBe("claimed");
	});

	it("persists checkpoints and refreshes their TTL", async () => {
		await putCheckpoint(ATTEMPT, "analysis", { value: "plan" });
		expect(await getCheckpoint<{ value: string }>(ATTEMPT, "analysis")).toEqual(
			{ found: true, value: { value: "plan" } },
		);
		expect(state.expires).toHaveBeenCalled();
	});

	it("distinguishes a stored null from a missing checkpoint", async () => {
		await putCheckpoint(ATTEMPT, "commit-1", null);
		expect(await getCheckpoint(ATTEMPT, "commit-1")).toEqual({
			found: true,
			value: null,
		});
		expect(await getCheckpoint(ATTEMPT, "missing")).toEqual({
			found: false,
		});
	});

	it("deletes and reports corrupt checkpoint JSON", async () => {
		const key = `factory:run:${ATTEMPT}:analysis`;
		state.values.set(key, "{");
		await expect(getCheckpoint(ATTEMPT, "analysis")).rejects.toThrow(
			/invalid JSON/,
		);
		expect(state.values.has(key)).toBe(false);
	});

	it("fails when the workflow loses its issue lease", async () => {
		await expect(refreshIntakeLease(REPO, 42, ATTEMPT)).rejects.toThrow(
			/lease was lost/,
		);
	});

	it("owns and refreshes one execution lock", async () => {
		expect(await claimExecution(ATTEMPT, "execution-1")).toBe(true);
		expect(await claimExecution(ATTEMPT, "execution-2")).toBe(false);
		await refreshExecution(ATTEMPT, "execution-1");
		await releaseExecution(ATTEMPT, "execution-1");
		expect(await claimExecution(ATTEMPT, "execution-2")).toBe(true);
	});

	it("increments failure counts atomically", async () => {
		expect(await incrementFailureCount(ATTEMPT)).toBe(1);
		expect(await incrementFailureCount(ATTEMPT)).toBe(2);
	});
});
