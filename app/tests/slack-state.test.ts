import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	values: new Map<string, string>(),
	lists: new Map<string, string[]>(),
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
		expire: async () => 1,
		lRange: async (key: string) => state.lists.get(key) ?? [],
		eval: async (
			script: string,
			options: { keys: string[]; arguments: string[] },
		) => {
			const [firstKey, secondKey] = options.keys;
			if (script.includes('redis.call("RPUSH"')) {
				if (state.values.has(secondKey)) return 0;
				state.values.set(secondKey, "1");
				const list = state.lists.get(firstKey) ?? [];
				list.push(options.arguments[0]);
				state.lists.set(firstKey, list.slice(-20));
				return 1;
			}
			if (script.includes('"dispatched"')) {
				if (state.values.get(firstKey) !== "pending") return 0;
				state.values.set(firstKey, "dispatched");
				return 1;
			}
			const [owner] = options.arguments;
			if (script.includes('redis.call("EXPIRE"')) {
				return state.values.get(firstKey) === owner ? 1 : 0;
			}
			if (state.values.get(firstKey) === owner) {
				state.values.delete(firstKey);
				return 1;
			}
			return 0;
		},
	}),
}));

import {
	appendSlackMessage,
	claimSlackDelivery,
	claimSlackThread,
	getSlackReply,
	getSlackThread,
	markSlackDispatched,
	putSlackReply,
	refreshSlackThread,
	releaseSlackThread,
} from "../lib/slack-state.js";

beforeEach(() => {
	state.values.clear();
	state.lists.clear();
});

describe("Slack state", () => {
	it("deduplicates dispatch and message append", async () => {
		expect(await claimSlackDelivery("event-1")).toBe("claimed");
		expect(await claimSlackDelivery("event-1")).toBe("pending");
		await markSlackDispatched("event-1");
		expect(await claimSlackDelivery("event-1")).toBe("dispatched");

		const message = {
			eventId: "event-1",
			role: "user" as const,
			content: "hello",
			ts: "now",
		};
		expect(await appendSlackMessage("thread-1", message)).toBe(true);
		expect(await appendSlackMessage("thread-1", message)).toBe(false);
		expect(await getSlackThread("thread-1")).toEqual([message]);
	});

	it("serializes each Slack thread", async () => {
		expect(await claimSlackThread("thread-1", "owner-1")).toBe(true);
		expect(await claimSlackThread("thread-1", "owner-2")).toBe(false);
		await refreshSlackThread("thread-1", "owner-1");
		await releaseSlackThread("thread-1", "owner-1");
		expect(await claimSlackThread("thread-1", "owner-2")).toBe(true);
	});

	it("checkpoints generated replies for delivery retries", async () => {
		expect(await getSlackReply("event-1")).toBeNull();
		await putSlackReply("event-1", "answer");
		expect(await getSlackReply("event-1")).toBe("answer");
	});
});
