import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	startTask: vi.fn(),
	claim: vi.fn(),
	mark: vi.fn(),
	abandon: vi.fn(),
}));

vi.mock("@renderinc/sdk", () => ({
	Render: class {
		workflows = { startTask: state.startTask };
	},
}));

vi.mock("../lib/slack-state.js", () => ({
	claimSlackDelivery: state.claim,
	markSlackDispatched: state.mark,
	abandonSlackDelivery: state.abandon,
}));

import { slackHandler } from "../gateway/slack.js";

const SECRET = "slack-test-secret";

function mention(overrides: Record<string, unknown> = {}) {
	return {
		type: "event_callback",
		event_id: "Ev123456789",
		event: {
			type: "app_mention",
			channel: "C123",
			channel_type: "channel",
			user: "U123",
			text: "<@UBOT> inspect the latest deploy",
			ts: "1700000000.000100",
			...overrides,
		},
	};
}

function post(
	payload: unknown,
	timestamp = Math.floor(Date.now() / 1000).toString(),
) {
	const body = JSON.stringify(payload);
	const signature = `v0=${createHmac("sha256", SECRET)
		.update(`v0:${timestamp}:${body}`)
		.digest("hex")}`;
	return slackHandler().request("/slack", {
		method: "POST",
		headers: {
			"x-slack-request-timestamp": timestamp,
			"x-slack-signature": signature,
		},
		body,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.SLACK_SIGNING_SECRET = SECRET;
	process.env.RENDER_WORKFLOW_SLUG = "acme/factory";
	state.claim.mockResolvedValue("claimed");
	state.mark.mockResolvedValue(undefined);
	state.abandon.mockResolvedValue(undefined);
	state.startTask.mockResolvedValue({ id: "run-1" });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.SLACK_SIGNING_SECRET;
	delete process.env.RENDER_WORKFLOW_SLUG;
});

describe("Slack assistant intake", () => {
	it("answers signed URL verification", async () => {
		const response = await post({
			type: "url_verification",
			challenge: "challenge",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ challenge: "challenge" });
	});

	it("dispatches a signed mention to the assistant workflow", async () => {
		const response = await post(mention());

		expect(response.status).toBe(200);
		expect(state.startTask).toHaveBeenCalledWith(
			"acme/factory/slack-assistant",
			[
				{
					eventId: "Ev123456789",
					message: "inspect the latest deploy",
					threadId: "C123:1700000000.000100",
					slackChannel: "C123",
					slackThreadTs: "1700000000.000100",
					slackUserId: "U123",
				},
			],
		);
		expect(state.mark).toHaveBeenCalledWith("Ev123456789");
	});

	it("accepts signed events from any Slack user and channel", async () => {
		const response = await post(mention({ user: "U999", channel: "C999" }));
		expect(response.status).toBe(200);
		expect(state.startTask).toHaveBeenCalledOnce();
	});

	it("recovers pending dispatches and skips completed dispatches", async () => {
		state.claim.mockResolvedValueOnce("pending");
		expect((await post(mention())).status).toBe(200);
		expect(state.startTask).toHaveBeenCalledOnce();

		state.startTask.mockClear();
		state.claim.mockResolvedValueOnce("dispatched");
		expect((await post(mention())).status).toBe(200);
		expect(state.startTask).not.toHaveBeenCalled();
	});

	it("abandons a new claim when dispatch fails", async () => {
		state.startTask.mockRejectedValue(new Error("offline"));
		const response = await post(mention());
		expect(response.status).toBe(503);
		expect(state.abandon).toHaveBeenCalledWith("Ev123456789");
	});

	it("rejects invalid signatures and timestamps", async () => {
		const invalid = await slackHandler().request("/slack", {
			method: "POST",
			headers: {
				"x-slack-request-timestamp": "1",
				"x-slack-signature": "v0=invalid",
			},
			body: JSON.stringify(mention()),
		});
		expect(invalid.status).toBe(401);
		expect((await post(mention(), "not-a-number")).status).toBe(401);
	});
});
