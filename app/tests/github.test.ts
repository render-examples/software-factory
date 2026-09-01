import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMemoryFactoryStore,
	type FactoryStore,
} from "#factory/store";

const { startTask } = vi.hoisted(() => ({
	startTask: vi.fn(),
}));

vi.mock("@renderinc/sdk", () => ({
	Render: class {
		workflows = { startTask };
	},
}));

import { githubHandler } from "../gateway/github.js";

const SECRET = "github-test-secret";
let store: FactoryStore;

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

function signedBody(payload: unknown): {
	body: string;
	signature: string;
} {
	const body = JSON.stringify(payload);
	return {
		body,
		signature: `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
	};
}

function post(event: string, payload: unknown, deliveryId = "delivery-123456") {
	const { body, signature } = signedBody(payload);
	return githubHandler({ store }).request("/github", {
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
	store = createMemoryFactoryStore();
	startTask.mockReset();
	startTask.mockResolvedValue({ taskRunId: "run-1" });
	process.env.FACTORY_REPO = "acme/factory";
	process.env.FACTORY_LABEL = "factory";
	process.env.FACTORY_GITHUB_ACTORS = "maintainer,second-maintainer";
	process.env.GITHUB_WEBHOOK_SECRET = SECRET;
	process.env.RENDER_WORKFLOW_SLUG = "acme/factory-workflows";
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await store.close();
	delete process.env.FACTORY_REPO;
	delete process.env.FACTORY_LABEL;
	delete process.env.FACTORY_GITHUB_ACTORS;
	delete process.env.GITHUB_WEBHOOK_SECRET;
	delete process.env.RENDER_WORKFLOW_SLUG;
});

describe("GitHub factory intake", () => {
	it("dispatches a generated run ID for an authorized label event", async () => {
		const response = await post("issues", issuePayload());

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ dispatched: "spec-to-pr" });
		expect(startTask).toHaveBeenCalledWith(
			"acme/factory-workflows/spec-to-pr",
			[
				expect.objectContaining({
					issueNumber: 42,
					runId: expect.any(String),
				}),
			],
		);
		const payload = startTask.mock.calls[0][1][0] as {
			runId: string;
		};
		expect(payload.runId).not.toBe("delivery-123456");
		expect(await store.inbox.getRunId("github", "delivery-123456")).toBe(
			payload.runId,
		);
	});

	it("deduplicates deliveries and leases active issues", async () => {
		expect((await post("issues", issuePayload())).status).toBe(202);

		const duplicate = await post("issues", issuePayload());
		expect(await duplicate.json()).toMatchObject({ reason: "dispatched" });

		const busy = await post("issues", issuePayload(), "delivery-654321");
		expect(await busy.json()).toMatchObject({ reason: "subject_busy" });
		expect(startTask).toHaveBeenCalledTimes(1);
	});

	it("redispatches a pending delivery after a gateway interruption", async () => {
		const deliveryId = "delivery-pending";
		const payload = issuePayload();
		const { body } = signedBody(payload);
		const runId = randomUUID();
		await store.inbox.accept({
			provider: "github",
			deliveryId,
			payloadDigest: createHash("sha256").update(body).digest("hex"),
			subjectKey: "github:acme/factory:issue:42",
			run: {
				id: runId,
				rootRunId: runId,
				kind: "workflow",
				name: "spec-to-pr",
			},
			deliveryTtlSeconds: 600,
			subjectLeaseTtlSeconds: 600,
		});

		const response = await post("issues", payload, deliveryId);

		expect(response.status).toBe(202);
		expect(startTask).toHaveBeenCalledWith(
			"acme/factory-workflows/spec-to-pr",
			[{ issueNumber: 42, runId }],
		);
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
		const response = await githubHandler({ store }).request("/github", {
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
		const { body, signature } = signedBody(issuePayload());
		const response = await githubHandler({ store }).request("/github", {
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
		const response = await githubHandler({ store }).request("/github", {
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

	it("returns 502 when workflow dispatch fails and permits redelivery", async () => {
		startTask
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({ taskRunId: "run-2" });
		const response = await post("issues", issuePayload());
		expect(response.status).toBe(502);
		const retry = await post("issues", issuePayload());
		expect(retry.status).toBe(202);
	});
});
