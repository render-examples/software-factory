import { createHash } from "node:crypto";
import { kv } from "#factory/sdk";

const THREAD_TTL_SECONDS = 30 * 24 * 60 * 60;
const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 30;
const MAX_THREAD_MESSAGES = 20;

const APPEND_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 1 then return 0 end
redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
redis.call("RPUSH", KEYS[1], ARGV[1])
redis.call("LTRIM", KEYS[1], -tonumber(ARGV[3]), -1)
redis.call("EXPIRE", KEYS[1], ARGV[2])
return 1
`;

const MARK_DISPATCHED_SCRIPT = `
if redis.call("GET", KEYS[1]) == "pending" then
  redis.call("SET", KEYS[1], "dispatched", "EX", ARGV[1])
  return 1
end
return 0
`;

const REFRESH_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  return 1
end
return 0
`;

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
end
return 0
`;

export interface SlackThreadMessage {
	eventId: string;
	role: "user" | "assistant";
	content: string;
	ts: string;
}

export type SlackDeliveryClaim = "claimed" | "pending" | "dispatched";

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function threadKey(threadId: string): string {
	return `slack:thread:${digest(threadId)}`;
}

function messageKey(eventId: string): string {
	return `slack:message:${digest(eventId)}`;
}

function deliveryKey(eventId: string): string {
	return `slack:delivery:${digest(eventId)}`;
}

function replyKey(eventId: string): string {
	return `slack:reply:${digest(eventId)}`;
}

function lockKey(threadId: string): string {
	return `slack:lock:${digest(threadId)}`;
}

export async function claimSlackDelivery(
	eventId: string,
): Promise<SlackDeliveryClaim> {
	const client = await kv();
	const claimed = await client.set(deliveryKey(eventId), "pending", {
		EX: DELIVERY_TTL_SECONDS,
		NX: true,
	});
	if (claimed === "OK") return "claimed";
	const state = await client.get(deliveryKey(eventId));
	return state === "dispatched" ? "dispatched" : "pending";
}

export async function markSlackDispatched(eventId: string): Promise<void> {
	const client = await kv();
	const result = await client.eval(MARK_DISPATCHED_SCRIPT, {
		keys: [deliveryKey(eventId)],
		arguments: [String(DELIVERY_TTL_SECONDS)],
	});
	if (Number(result) !== 1) throw new Error("Slack delivery claim was lost");
}

export async function abandonSlackDelivery(eventId: string): Promise<void> {
	const client = await kv();
	const key = deliveryKey(eventId);
	if ((await client.get(key)) === "pending") await client.del(key);
}

export async function appendSlackMessage(
	threadId: string,
	message: SlackThreadMessage,
): Promise<boolean> {
	const client = await kv();
	const result = await client.eval(APPEND_SCRIPT, {
		keys: [threadKey(threadId), messageKey(message.eventId)],
		arguments: [
			JSON.stringify(message),
			String(THREAD_TTL_SECONDS),
			String(MAX_THREAD_MESSAGES),
		],
	});
	return Number(result) === 1;
}

export async function getSlackThread(
	threadId: string,
): Promise<SlackThreadMessage[]> {
	const client = await kv();
	const values = await client.lRange(threadKey(threadId), 0, -1);
	await client.expire(threadKey(threadId), THREAD_TTL_SECONDS);
	return values.flatMap((value) => {
		try {
			return [JSON.parse(value) as SlackThreadMessage];
		} catch {
			return [];
		}
	});
}

export async function claimSlackThread(
	threadId: string,
	ownerId: string,
): Promise<boolean> {
	const client = await kv();
	const result = await client.set(lockKey(threadId), ownerId, {
		EX: LOCK_TTL_SECONDS,
		NX: true,
	});
	return result === "OK";
}

export async function refreshSlackThread(
	threadId: string,
	ownerId: string,
): Promise<void> {
	const client = await kv();
	const result = await client.eval(REFRESH_IF_OWNER_SCRIPT, {
		keys: [lockKey(threadId)],
		arguments: [ownerId, String(LOCK_TTL_SECONDS)],
	});
	if (Number(result) !== 1) throw new Error("Slack thread lock was lost");
}

export async function releaseSlackThread(
	threadId: string,
	ownerId: string,
): Promise<void> {
	const client = await kv();
	await client.eval(RELEASE_IF_OWNER_SCRIPT, {
		keys: [lockKey(threadId)],
		arguments: [ownerId],
	});
}

export async function markSlackReplyDelivered(eventId: string): Promise<void> {
	const client = await kv();
	await client.set(`slack:delivered:${digest(eventId)}`, "1", {
		EX: DELIVERY_TTL_SECONDS,
	});
}

export async function wasSlackReplyDelivered(
	eventId: string,
): Promise<boolean> {
	const client = await kv();
	return (await client.get(`slack:delivered:${digest(eventId)}`)) === "1";
}

export async function getSlackReply(eventId: string): Promise<string | null> {
	const client = await kv();
	const key = replyKey(eventId);
	const reply = await client.get(key);
	if (reply !== null) await client.expire(key, DELIVERY_TTL_SECONDS);
	return reply;
}

export async function putSlackReply(
	eventId: string,
	reply: string,
): Promise<void> {
	const client = await kv();
	await client.set(replyKey(eventId), reply, { EX: DELIVERY_TTL_SECONDS });
}
