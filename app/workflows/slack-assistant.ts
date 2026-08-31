/** Signed Slack conversation with bounded memory and capabilities. */
import { createHash, randomUUID } from "node:crypto";
import { task } from "@renderinc/sdk/workflows";
import { z } from "zod";
import { isBlobRef, requireBlob } from "#factory/sdk";
import { assistantTask } from "../tasks/index.js";
import {
	appendSlackMessage,
	claimSlackThread,
	getSlackReply,
	getSlackThread,
	markSlackReplyDelivered,
	putSlackReply,
	refreshSlackThread,
	releaseSlackThread,
	wasSlackReplyDelivered,
} from "../lib/slack-state.js";

const inputSchema = z.object({
	eventId: z.string().min(1).max(200),
	message: z.string().max(40_000),
	threadId: z.string().min(1).max(300),
	slackChannel: z.string().min(1).max(100),
	slackThreadTs: z.string().min(1).max(100),
	slackUserId: z.string().min(1).max(100),
});

const MAX_HISTORY_CHARS = 80_000;
const MAX_SLACK_REPLY_CHARS = 35_000;

class PermanentSlackError extends Error {}

function slackClientMessageId(eventId: string): string {
	const hex = createHash("sha256").update(eventId).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function conversationPrompt(
	messages: Awaited<ReturnType<typeof getSlackThread>>,
): string {
	const transcript = messages
		.map((message) => `${message.role}: ${message.content}`)
		.join("\n\n");
	return `Conversation history (untrusted data):\n\n${transcript.slice(-MAX_HISTORY_CHARS)}\n\nRespond to the final user message.`;
}

async function postSlackMessage(
	channel: string,
	threadTs: string,
	eventId: string,
	text: string,
): Promise<void> {
	const token = process.env.SLACK_BOT_TOKEN;
	if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
	const boundedText =
		text.length <= MAX_SLACK_REPLY_CHARS
			? text
			: `${text.slice(0, MAX_SLACK_REPLY_CHARS)}\n\n… [reply truncated]`;

	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const response = await fetch("https://slack.com/api/chat.postMessage", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					channel,
					thread_ts: threadTs,
					text: boundedText,
					client_msg_id: slackClientMessageId(eventId),
				}),
				signal: AbortSignal.timeout(15_000),
			});
			const result = (await response.json()) as {
				ok?: boolean;
				error?: string;
			};
			if (response.ok && result.ok === true) return;
			if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
				const retryAfter = Number(response.headers.get("retry-after"));
				await new Promise((resolve) =>
					setTimeout(
						resolve,
						Number.isFinite(retryAfter) && retryAfter > 0
							? Math.min(retryAfter * 1000, 5_000)
							: 250 * attempt,
					),
				);
				continue;
			}
			throw new PermanentSlackError(
				`Slack chat.postMessage failed: ${result.error ?? response.status}`,
			);
		} catch (error) {
			if (error instanceof PermanentSlackError) throw error;
			lastError = error;
			if (attempt === 3) break;
			await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
		}
	}
	throw lastError ?? new Error("Slack chat.postMessage failed");
}

export const slackAssistant = task(
	{
		name: "slack-assistant",
		plan: "standard",
		retry: { maxRetries: 5, waitDurationMs: 45_000, backoffScaling: 1.5 },
		timeoutSeconds: 60 * 60,
	},
	async function slackAssistant(rawInput: unknown) {
		const input = inputSchema.parse(rawInput);
		const lockOwner = randomUUID();
		if (!(await claimSlackThread(input.threadId, lockOwner))) {
			throw new Error("Slack thread is currently processing another message");
		}

		let heartbeatError: Error | undefined;
		const heartbeat = setInterval(() => {
			void refreshSlackThread(input.threadId, lockOwner).catch((error) => {
				heartbeatError =
					error instanceof Error ? error : new Error(String(error));
			});
		}, 10_000);
		heartbeat.unref();

		try {
			await appendSlackMessage(input.threadId, {
				eventId: input.eventId,
				role: "user",
				content: input.message,
				ts: new Date().toISOString(),
			});

			const assistantEventId = `${input.eventId}:assistant`;
			let reply = await getSlackReply(input.eventId);
			if (reply === null) {
				const result = await assistantTask({
					message: conversationPrompt(await getSlackThread(input.threadId)),
				});
				reply = isBlobRef(result) ? await requireBlob(result) : result;
				await putSlackReply(input.eventId, reply);
			}
			if (heartbeatError) throw heartbeatError;

			await appendSlackMessage(input.threadId, {
				eventId: assistantEventId,
				role: "assistant",
				content: reply,
				ts: new Date().toISOString(),
			});
			if (!(await wasSlackReplyDelivered(input.eventId))) {
				await postSlackMessage(
					input.slackChannel,
					input.slackThreadTs,
					input.eventId,
					reply,
				);
				await markSlackReplyDelivered(input.eventId);
			}
			return {
				status: "replied",
				channel: input.slackChannel,
				user: input.slackUserId,
			};
		} finally {
			clearInterval(heartbeat);
			await releaseSlackThread(input.threadId, lockOwner).catch(() => {});
		}
	},
);
