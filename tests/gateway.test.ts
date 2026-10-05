import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createQueuedRun: vi.fn(),
	finishRun: vi.fn(),
	recordDelivery: vi.fn(),
	ping: vi.fn(),
	startTask: vi.fn(),
}));

vi.mock("../app/store/index.js", () => ({
	createQueuedRun: mocks.createQueuedRun,
	finishRun: mocks.finishRun,
	recordDelivery: mocks.recordDelivery,
	ping: mocks.ping,
}));

vi.mock("@renderinc/sdk", () => ({
	Render: class {
		workflows = { startTask: mocks.startTask };
	},
}));

const { createGateway } = await import("../app/gateway/index.js");

const SECRET = "webhook-secret";

function payload(overrides: Record<string, unknown> = {}) {
	return {
		action: "labeled",
		issue: { number: 42 },
		label: { name: "factory:full-run" },
		repository: { full_name: "jacobprall/render-factory-sample" },
		sender: { login: "Maintainer", type: "User" },
		...overrides,
	};
}

function post(
	body: unknown,
	opts: { signature?: string; event?: string; delivery?: string | null } = {},
) {
	const raw = typeof body === "string" ? body : JSON.stringify(body);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-github-event": opts.event ?? "issues",
		"x-hub-signature-256":
			opts.signature ??
			`sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
	};
	if (opts.delivery !== null) headers["x-github-delivery"] = opts.delivery ?? "delivery-0001";

	return createGateway().request("/webhooks/github", {
		method: "POST",
		headers,
		body: raw,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createQueuedRun.mockResolvedValue(true);
	mocks.finishRun.mockResolvedValue(undefined);
	mocks.recordDelivery.mockResolvedValue(undefined);
	mocks.ping.mockResolvedValue(undefined);
	mocks.startTask.mockResolvedValue({ taskRunId: "trn-1" });

	process.env.FACTORY_GITHUB_ACTORS = "maintainer";
	process.env.GITHUB_WEBHOOK_SECRET = SECRET;
	process.env.RENDER_WORKFLOW_SLUG = "wfs-1";
});

describe("health", () => {
	it("reports liveness without touching Postgres", async () => {
		const response = await createGateway().request("/health");
		expect(response.status).toBe(200);
		expect(mocks.ping).not.toHaveBeenCalled();
	});

	it("reports 503 when Postgres is unreachable", async () => {
		mocks.ping.mockRejectedValue(new Error("down"));
		const response = await createGateway().request("/ready");
		expect(response.status).toBe(503);
	});
});

describe("authentication", () => {
	it("rejects a wrong signature before parsing the body", async () => {
		const response = await post(payload(), { signature: "sha256=deadbeef" });
		expect(response.status).toBe(401);
		expect(mocks.createQueuedRun).not.toHaveBeenCalled();
	});

	it("rejects a request with no signature", async () => {
		const response = await post(payload(), { signature: "" });
		expect(response.status).toBe(401);
	});

	it("rejects a body over the size cap", async () => {
		const response = await post(JSON.stringify({ padding: "x".repeat(300 * 1024) }));
		expect(response.status).toBe(413);
	});
});

describe("event filtering", () => {
	it("ignores events other than issues", async () => {
		const response = await post(payload(), { event: "push" });
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("rejects malformed JSON that carries a valid signature", async () => {
		const response = await post("{not json");
		expect(response.status).toBe(400);
	});

	it.each([
		["a non-labeled action", payload({ action: "opened" })],
		["a different label", payload({ label: { name: "bug" } })],
		["another repository", payload({ repository: { full_name: "acme/other" } })],
		["a pull request", payload({ issue: { number: 42, pull_request: {} } })],
		["a bot sender", payload({ sender: { login: "maintainer", type: "Bot" } })],
		["an actor not on the allowlist", payload({ sender: { login: "stranger", type: "User" } })],
	])("skips %s", async (_label, body) => {
		const response = await post(body);
		expect(await response.json()).toMatchObject({ skipped: true });
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("requires a well-formed delivery ID", async () => {
		expect((await post(payload(), { delivery: null })).status).toBe(400);
		expect((await post(payload(), { delivery: "short" })).status).toBe(400);
	});
});

describe("dispatch", () => {
	it("creates a queued run and starts the workflow task", async () => {
		const response = await post(payload());

		expect(response.status).toBe(202);
		expect(mocks.createQueuedRun).toHaveBeenCalledWith(
			expect.objectContaining({
				repo: "jacobprall/render-factory-sample",
				subjectKind: "issue",
				subjectNumber: 42,
				workflow: "spec-to-pr",
			}),
		);
		expect(mocks.startTask).toHaveBeenCalledWith(
			"wfs-1/spec-to-pr",
			[expect.objectContaining({ issueNumber: 42 })],
		);
	});

	it("records a delivery", async () => {
		await post(payload());
		expect(mocks.recordDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				deliveryId: "delivery-0001",
				event: "issues",
				outcome: "accepted",
			}),
		);
	});

	it("matches the actor allowlist case-insensitively", async () => {
		const response = await post(payload({ sender: { login: "MAINTAINER", type: "User" } }));
		expect(response.status).toBe(202);
	});

	it("skips when the run claim is refused (duplicate active run)", async () => {
		mocks.createQueuedRun.mockResolvedValue(false);
		const response = await post(payload());

		expect(await response.json()).toMatchObject({ skipped: true });
		expect(mocks.startTask).not.toHaveBeenCalled();
	});

	it("releases the run when dispatch fails so a retry can succeed", async () => {
		mocks.startTask.mockRejectedValue(new Error("render unavailable"));
		const response = await post(payload());

		expect(response.status).toBe(502);
		expect(mocks.finishRun).toHaveBeenCalledWith(
			expect.any(String),
			"failed",
			expect.objectContaining({ summary: "dispatch failed" }),
		);
	});

	it("fails when the workflow slug is not configured", async () => {
		process.env.RENDER_WORKFLOW_SLUG = "";
		const response = await post(payload());
		expect(response.status).toBe(502);
	});
});
