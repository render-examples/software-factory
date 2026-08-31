import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	assistantTask: vi.fn(),
	append: vi.fn(),
	claimThread: vi.fn(),
	getReply: vi.fn(),
	getThread: vi.fn(),
	markDelivered: vi.fn(),
	putReply: vi.fn(),
	refreshThread: vi.fn(),
	releaseThread: vi.fn(),
	wasDelivered: vi.fn(),
}));

vi.mock("../tasks/index.js", () => ({
	assistantTask: state.assistantTask,
}));

vi.mock("../lib/slack-state.js", () => ({
	appendSlackMessage: state.append,
	claimSlackThread: state.claimThread,
	getSlackReply: state.getReply,
	getSlackThread: state.getThread,
	markSlackReplyDelivered: state.markDelivered,
	putSlackReply: state.putReply,
	refreshSlackThread: state.refreshThread,
	releaseSlackThread: state.releaseThread,
	wasSlackReplyDelivered: state.wasDelivered,
}));

import { slackAssistant } from "../workflows/slack-assistant.js";

const input = {
	eventId: "Ev123",
	message: "What changed?",
	threadId: "C123:1.0",
	slackChannel: "C123",
	slackThreadTs: "1.0",
	slackUserId: "U123",
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.SLACK_BOT_TOKEN = "xoxb-test";
	state.claimThread.mockResolvedValue(true);
	state.getReply.mockResolvedValue(null);
	state.getThread.mockResolvedValue([
		{
			eventId: "Ev123",
			role: "user",
			content: "What changed?",
			ts: "now",
		},
	]);
	state.assistantTask.mockResolvedValue("The answer");
	state.wasDelivered.mockResolvedValue(false);
	state.releaseThread.mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, ts: "2.0" }), {
				status: 200,
			}),
		),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	delete process.env.SLACK_BOT_TOKEN;
});

describe("slack-assistant workflow", () => {
	it("uses capped history, checkpoints the reply, and posts to Slack", async () => {
		const result = await slackAssistant(input);

		expect(result).toEqual({
			status: "replied",
			channel: "C123",
			user: "U123",
		});
		expect(state.assistantTask).toHaveBeenCalledWith({
			message: expect.stringContaining("user: What changed?"),
		});
		expect(state.putReply).toHaveBeenCalledWith("Ev123", "The answer");
		expect(state.markDelivered).toHaveBeenCalledWith("Ev123");
		expect(fetch).toHaveBeenCalledOnce();
		expect(state.releaseThread).toHaveBeenCalled();
	});

	it("reuses a generated reply and does not repost a delivered event", async () => {
		state.getReply.mockResolvedValue("Cached answer");
		state.wasDelivered.mockResolvedValue(true);

		await slackAssistant(input);

		expect(state.assistantTask).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("treats Slack HTTP-200 logical errors as workflow failures", async () => {
		vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 200,
        }),
		);

		const pending = slackAssistant(input);
    const rejection = expect(pending).rejects.toThrow(/invalid_auth/);
		await vi.runAllTimersAsync();

    await rejection;
		expect(state.markDelivered).not.toHaveBeenCalled();
		expect(state.releaseThread).toHaveBeenCalled();
	});
});
