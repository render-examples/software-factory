import { createHash, randomBytes, randomUUID } from "node:crypto";
import { StoreConflictError } from "./contracts.js";

export const MAX_EVENT_PAYLOAD_BYTES = 4_096;
export const MAX_STORE_KEY_CHARS = 300;

export function defaultRandomId(): string {
	return randomUUID();
}

export function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

export function assertStoreKey(value: string, label: string): void {
	const hasControlCharacter = [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (
		value.length < 1 ||
		value.length > MAX_STORE_KEY_CHARS ||
		hasControlCharacter
	) {
		throw new StoreConflictError(`Invalid ${label}`);
	}
}

export function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new StoreConflictError(`${label} must be a positive safe integer`);
	}
}

export function canonicalJson(value: unknown): string {
	const serialized = JSON.stringify(
		sortValue(normalizeJsonValue(value)),
	);
	if (serialized === undefined) {
		throw new StoreConflictError("Stored value is not JSON-serializable");
	}
	return serialized;
}

export function valueDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function normalizeJsonValue<T>(value: T): T {
	return normalize(value, new Set()) as T;
}

export function assertEventPayload(
	payload: Record<string, unknown>,
): void {
	const bytes = Buffer.byteLength(canonicalJson(payload), "utf8");
	if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
		throw new StoreConflictError(
			`Run event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
		);
	}
}

export function artifactRef(
	runId: string,
	namespace: string,
): string {
	assertStoreKey(runId, "artifact run ID");
	assertStoreKey(namespace, "artifact namespace");
	const capability = randomBytes(16).toString("hex");
	return `$blob:blob:${encodeURIComponent(runId)}:${encodeURIComponent(namespace)}:${capability}`;
}

export function isArtifactRef(value: string): boolean {
	return /^\$blob:blob:[^\s]+$/.test(value);
}

export function expiresAt(now: Date, ttlSeconds: number): Date {
	assertPositiveInteger(ttlSeconds, "TTL");
	return new Date(now.getTime() + ttlSeconds * 1_000);
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(record)
			.sort()
			.map((key) => [key, sortValue(record[key])]),
	);
}

function normalize(value: unknown, seen: Set<object>): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new StoreConflictError("Stored numbers must be finite");
		}
		return value;
	}
	if (
		typeof value === "undefined" ||
		typeof value === "bigint" ||
		typeof value === "function" ||
		typeof value === "symbol"
	) {
		throw new StoreConflictError("Stored value is not JSON-serializable");
	}
	if (seen.has(value)) {
		throw new StoreConflictError("Stored value contains a cycle");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => normalize(item, seen));
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new StoreConflictError(
				"Stored values must contain only plain JSON objects",
			);
		}
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, item]) => item !== undefined)
				.map(([key, item]) => [key, normalize(item, seen)]),
		);
	} finally {
		seen.delete(value);
	}
}
