import { kv } from "#factory/sdk";

const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60;
const LEASE_TTL_SECONDS = 26 * 60 * 60;
const CHECKPOINT_TTL_SECONDS = 7 * 24 * 60 * 60;
const EXECUTION_LOCK_TTL_SECONDS = 30;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const STAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const CLAIM_SCRIPT = `
local delivery = redis.call("GET", KEYS[1])
if delivery then
  if delivery == "completed:" .. ARGV[1] then return "completed" end
  if delivery == "dispatched:" .. ARGV[1] then return "dispatched" end
  return "pending"
end
if redis.call("EXISTS", KEYS[2]) == 1 then return "busy" end
redis.call("SET", KEYS[1], "pending:" .. ARGV[1], "EX", ARGV[2])
redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[3])
return "claimed"
`;

const MARK_DISPATCHED_SCRIPT = `
local expected = "pending:" .. ARGV[1]
local current = redis.call("GET", KEYS[1])
if current == expected or current == "dispatched:" .. ARGV[1] then
  redis.call("SET", KEYS[1], "dispatched:" .. ARGV[1], "EX", ARGV[2])
  return 1
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[2]) == ARGV[1] then redis.call("DEL", KEYS[2]) end
local delivery = redis.call("GET", KEYS[1])
if ARGV[2] == "delete" and delivery and string.sub(delivery, -string.len(ARGV[1])) == ARGV[1] then
  redis.call("DEL", KEYS[1])
elseif ARGV[2] == "complete" and delivery and string.sub(delivery, -string.len(ARGV[1])) == ARGV[1] then
  redis.call("SET", KEYS[1], "completed:" .. ARGV[1], "EX", ARGV[3])
end
return 1
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

const INCREMENT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
redis.call("EXPIRE", KEYS[1], ARGV[1])
return count
`;

export type IntakeClaim =
	| "claimed"
	| "pending"
	| "dispatched"
	| "completed"
	| "busy";

export type Checkpoint<T> = { found: true; value: T } | { found: false };

function validateAttemptId(attemptId: string): void {
	if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
		throw new Error("Invalid factory attempt ID");
	}
}

function validateStage(stage: string): void {
	if (!STAGE_PATTERN.test(stage)) {
		throw new Error("Invalid checkpoint stage");
	}
}

function scope(repository: string): string {
	return encodeURIComponent(repository.toLowerCase());
}

function deliveryKey(repository: string, attemptId: string): string {
	return `factory:delivery:${scope(repository)}:${attemptId}`;
}

function leaseKey(repository: string, issueNumber: number): string {
	return `factory:lease:${scope(repository)}:${issueNumber}`;
}

function checkpointKey(attemptId: string, stage: string): string {
	validateAttemptId(attemptId);
	validateStage(stage);
	return `factory:run:${attemptId}:${stage}`;
}

function executionKey(attemptId: string): string {
	validateAttemptId(attemptId);
	return `factory:execution:${attemptId}`;
}

export async function claimIntake(
	repository: string,
	issueNumber: number,
	attemptId: string,
): Promise<IntakeClaim> {
	validateAttemptId(attemptId);
	const client = await kv();
	const result = await client.eval(CLAIM_SCRIPT, {
		keys: [
			deliveryKey(repository, attemptId),
			leaseKey(repository, issueNumber),
		],
		arguments: [
			attemptId,
			String(DELIVERY_TTL_SECONDS),
			String(LEASE_TTL_SECONDS),
		],
	});
	if (
		result === "claimed" ||
		result === "pending" ||
		result === "dispatched" ||
		result === "completed" ||
		result === "busy"
	) {
		return result;
	}
	throw new Error(`Unexpected intake claim result: ${String(result)}`);
}

export async function markIntakeDispatched(
	repository: string,
	attemptId: string,
): Promise<void> {
	validateAttemptId(attemptId);
	const client = await kv();
	const marked = await client.eval(MARK_DISPATCHED_SCRIPT, {
		keys: [deliveryKey(repository, attemptId)],
		arguments: [attemptId, String(DELIVERY_TTL_SECONDS)],
	});
	if (Number(marked) !== 1) {
		throw new Error("Intake delivery claim was lost before dispatch completed");
	}
}

async function release(
	repository: string,
	issueNumber: number,
	attemptId: string,
	mode: "delete" | "complete",
): Promise<void> {
	validateAttemptId(attemptId);
	const client = await kv();
	await client.eval(RELEASE_SCRIPT, {
		keys: [
			deliveryKey(repository, attemptId),
			leaseKey(repository, issueNumber),
		],
		arguments: [attemptId, mode, String(DELIVERY_TTL_SECONDS)],
	});
}

export function abandonIntake(
	repository: string,
	issueNumber: number,
	attemptId: string,
): Promise<void> {
	return release(repository, issueNumber, attemptId, "delete");
}

export function completeIntake(
	repository: string,
	issueNumber: number,
	attemptId: string,
): Promise<void> {
	return release(repository, issueNumber, attemptId, "complete");
}

export async function refreshIntakeLease(
	repository: string,
	issueNumber: number,
	attemptId: string,
): Promise<void> {
	validateAttemptId(attemptId);
	const client = await kv();
	const refreshed = await client.eval(REFRESH_IF_OWNER_SCRIPT, {
		keys: [leaseKey(repository, issueNumber)],
		arguments: [attemptId, String(LEASE_TTL_SECONDS)],
	});
	if (Number(refreshed) !== 1) {
		throw new Error("Factory issue lease was lost");
	}
}

export async function claimExecution(
	attemptId: string,
	executionId: string,
): Promise<boolean> {
	validateAttemptId(attemptId);
	const client = await kv();
	const result = await client.set(executionKey(attemptId), executionId, {
		EX: EXECUTION_LOCK_TTL_SECONDS,
		NX: true,
	});
	return result === "OK";
}

export async function refreshExecution(
	attemptId: string,
	executionId: string,
): Promise<void> {
	const client = await kv();
	const refreshed = await client.eval(REFRESH_IF_OWNER_SCRIPT, {
		keys: [executionKey(attemptId)],
		arguments: [executionId, String(EXECUTION_LOCK_TTL_SECONDS)],
	});
	if (Number(refreshed) !== 1) {
		throw new Error("Factory execution lock was lost");
	}
}

export async function releaseExecution(
	attemptId: string,
	executionId: string,
): Promise<void> {
	const client = await kv();
	await client.eval(RELEASE_IF_OWNER_SCRIPT, {
		keys: [executionKey(attemptId)],
		arguments: [executionId],
	});
}

export async function getCheckpoint<T>(
	attemptId: string,
	stage: string,
): Promise<Checkpoint<T>> {
	const key = checkpointKey(attemptId, stage);
	const client = await kv();
	const value = await client.get(key);
	if (value === null) return { found: false };
	await client.expire(key, CHECKPOINT_TTL_SECONDS);
	try {
		return { found: true, value: JSON.parse(value) as T };
	} catch (error) {
		await client.del(key);
		throw new Error(`Checkpoint "${stage}" contained invalid JSON`, {
			cause: error,
		});
	}
}

export async function putCheckpoint<T>(
	attemptId: string,
	stage: string,
	value: T,
): Promise<T> {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new Error(`Checkpoint "${stage}" is not JSON-serializable`);
	}
	const client = await kv();
	await client.set(checkpointKey(attemptId, stage), serialized, {
		EX: CHECKPOINT_TTL_SECONDS,
	});
	return value;
}

export async function clearCheckpoints(
	attemptId: string,
	stages: readonly string[],
): Promise<void> {
	const client = await kv();
	await Promise.all(
		stages.map((stage) => client.del(checkpointKey(attemptId, stage))),
	);
}

export async function incrementFailureCount(
	attemptId: string,
): Promise<number> {
	const client = await kv();
	const count = await client.eval(INCREMENT_SCRIPT, {
		keys: [checkpointKey(attemptId, "failure-count")],
		arguments: [String(CHECKPOINT_TTL_SECONDS)],
	});
	return Number(count);
}
