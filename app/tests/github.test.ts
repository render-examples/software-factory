import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startTask, redisStore } = vi.hoisted(() => ({
	startTask: vi.fn(),
	redisStore: new Map<string, string>(),
}));

vi.mock("@renderinc/sdk", () => ({
	Render: class {
		workflows = { startTask };
	},
}));

vi.mock("../../sdk/redis.js", () => ({
	kv: async () => ({
		eval: async (
			script: string,
			options: { keys: string[]; arguments: string[] },
		) => {
			const [deliveryKey, leaseKey] = options.keys;
			const [attemptId, mode] = options.arguments;
			if (script.includes('return "claimed"')) {
				const delivery = redisStore.get(deliveryKey);
				if (delivery?.startsWith("completed:")) return "completed";
				if (delivery?.startsWith("dispatched:")) return "dispatched";
				if (delivery) return "pending";
				if (redisStore.has(leaseKey)) return "busy";
				redisStore.set(deliveryKey, `pending:${attemptId}`);
				redisStore.set(leaseKey, attemptId);
				return "claimed";
			}
			if (script.includes("local expected")) {
				if (redisStore.get(deliveryKey) !== `pending:${attemptId}`) return 0;
				redisStore.set(deliveryKey, `dispatched:${attemptId}`);
				return 1;
			}
			if (redisStore.get(leaseKey) === attemptId) {
				redisStore.delete(leaseKey);
			}
			if (
				mode === "delete" &&
				redisStore.get(deliveryKey)?.endsWith(attemptId)
			) {
				redisStore.delete(deliveryKey);
			}
			return 1;
		},
	}),
}));

import { githubHandler } from "../gateway/github.js";

const SECRET = "github-test-secret";

function issuePayload(overrides: Record<string, unknown> = {}) {
	return {
		action: "labeled",
		repository: { full_name: "acme/factory" },
		sender: { login: "maintainer", type: "User" },
		issue: { number: 42 },
		label: { name: "factory" },
		...overrides,
	};
}

function post(event: string, payload: unknown, deliveryId = "delivery-123456") {
	const body = JSON.stringify(payload);
	const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
	return githubHandler().request("/github", {
		method: "POST",
		headers: {
			"x-github-event": event,
			"x-github-delivery": deliveryId,
			"x-hub-signature-256": signature,
		},
		body,
	});
}

beforeEach(() => {
	redisStore.clear();
	startTask.mockReset();
	startTask.mockResolvedValue({ id: "run-1" });
	process.env.FACTORY_REPO = "acme/factory";
	process.env.FACTORY_LABEL = "factory";
	process.env.FACTORY_GITHUB_ACTORS = "maintainer,second-maintainer";
	process.env.GITHUB_WEBHOOK_SECRET = SECRET;
	process.env.RENDER_WORKFLOW_SLUG = "acme/factory-workflows";
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.FACTORY_REPO;
	delete process.env.FACTORY_LABEL;
	delete process.env.FACTORY_GITHUB_ACTORS;
	delete process.env.GITHUB_WEBHOOK_SECRET;
	delete process.env.RENDER_WORKFLOW_SLUG;
});

describe("GitHub factory intake", () => {
	it("dispatches only the issue number for an authorized label event", async () => {
		const response = await post("issues", issuePayload());

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ dispatched: "spec-to-pr" });
		expect(startTask).toHaveBeenCalledWith(
			"acme/factory-workflows/spec-to-pr",
			[{ issueNumber: 42, attemptId: "delivery-123456" }],
		);
	});

	it("deduplicates deliveries and leases active issues", async () => {
		expect((await post("issues", issuePayload())).status).toBe(202);

		const duplicate = await post("issues", issuePayload());
		expect(await duplicate.json()).toMatchObject({ reason: "dispatched" });

		const busy = await post("issues", issuePayload(), "delivery-654321");
		expect(await busy.json()).toMatchObject({ reason: "busy" });
		expect(startTask).toHaveBeenCalledTimes(1);
	});

	it("redispatches a claimed delivery when the gateway died before dispatch", async () => {
		const attemptId = "delivery-pending";
		redisStore.set(
			`factory:delivery:acme%2Ffactory:${attemptId}`,
			`pending:${attemptId}`,
		);
		redisStore.set("factory:lease:acme%2Ffactory:42", attemptId);

		const response = await post("issues", issuePayload(), attemptId);

		expect(response.status).toBe(202);
		expect(startTask).toHaveBeenCalledOnce();
	});

	it.each([
		["unsupported event", "pull_request", issuePayload()],
		["wrong action", "issues", issuePayload({ action: "opened" })],
		["wrong label", "issues", issuePayload({ label: { name: "bug" } })],
		[
			"wrong repository",
			"issues",
			issuePayload({ repository: { full_name: "acme/other" } }),
		],
		[
			"unauthorized actor",
			"issues",
			issuePayload({ sender: { login: "outsider", type: "User" } }),
		],
		[
			"bot actor",
			"issues",
			issuePayload({ sender: { login: "bot", type: "Bot" } }),
		],
		[
			"pull request conversation",
			"issues",
			issuePayload({ issue: { number: 42, pull_request: {} } }),
		],
	])("skips %s", async (_name, event, payload) => {
		const response = await post(event, payload);
		expect(response.status).toBe(200);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("rejects an invalid signature", async () => {
		const response = await githubHandler().request("/github", {
			method: "POST",
			headers: {
				"x-github-event": "issues",
				"x-github-delivery": "delivery-invalid",
				"x-hub-signature-256": "sha256=invalid",
			},
			body: JSON.stringify(issuePayload()),
		});
		expect(response.status).toBe(401);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("requires a valid GitHub delivery ID", async () => {
		const body = JSON.stringify(issuePayload());
		const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
		const response = await githubHandler().request("/github", {
			method: "POST",
			headers: {
				"x-github-event": "issues",
				"x-hub-signature-256": signature,
			},
			body,
		});
		expect(response.status).toBe(400);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("rejects malformed signed JSON", async () => {
		const body = "{";
		const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
		const response = await githubHandler().request("/github", {
			method: "POST",
			headers: {
				"x-github-event": "issues",
				"x-github-delivery": "delivery-malformed",
				"x-hub-signature-256": signature,
			},
			body,
		});
		expect(response.status).toBe(400);
	});

	it("rejects oversized payloads", async () => {
		const response = await post(
			"issues",
			issuePayload({ padding: "x".repeat(300_000) }),
		);
		expect(response.status).toBe(413);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("returns 503 when workflow dispatch is not configured", async () => {
		delete process.env.RENDER_WORKFLOW_SLUG;
		const response = await post("issues", issuePayload());
		expect(response.status).toBe(503);
	});

	it("returns 502 when workflow dispatch fails", async () => {
		startTask
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({ id: "run-2" });
		const response = await post("issues", issuePayload());
		expect(response.status).toBe(502);
		const retry = await post("issues", issuePayload());
		expect(retry.status).toBe(202);
	});
});
