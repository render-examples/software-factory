/**
 * Redis-backed handoff artifacts for large agent outputs.
 * Oversized results become opaque `$blob:blob:<key>` refs that workflow code
 * resolves explicitly; user-authored text is never scanned for references.
 */
import { randomBytes } from "node:crypto";
import { kv } from "./redis.js";

const REF_PREFIX = "$blob:";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // Match run checkpoints.
export const BLOB_THRESHOLD = 50_000; // characters

function blobKey(runId: string, step: string): string {
  const capability = randomBytes(16).toString("hex");
  return `blob:${encodeURIComponent(runId)}:${encodeURIComponent(step)}:${capability}`;
}

export function isBlobRef(value: string): boolean {
  return /^\$blob:blob:[^\s]+$/.test(value);
}

function keyFromRef(ref: string): string | null {
  if (!isBlobRef(ref)) return null;
  return ref.slice(REF_PREFIX.length);
}

export async function putBlob(
  runId: string,
  step: string,
  content: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const key = blobKey(runId, step);
  const client = await kv();
  await client.set(key, content, { EX: ttlSeconds });
  return `${REF_PREFIX}${key}`;
}

export async function getBlob(ref: string): Promise<string | null> {
  const key = keyFromRef(ref);
  if (!key) return null;
  const client = await kv();
  const content = await client.get(key);
  if (content !== null) {
    await client.expire(key, DEFAULT_TTL_SECONDS);
  }
  return content;
}

export async function delBlob(ref: string): Promise<void> {
  const key = keyFromRef(ref);
  if (!key) return;
  const client = await kv();
  await client.del(key);
}

/** Resolve one trusted, typed blob reference and fail if it has expired. */
export async function requireBlob(ref: string): Promise<string> {
  const content = await getBlob(ref);
  if (content === null) {
    throw new Error("Blob reference is invalid or expired");
  }
  return content;
}

/** Store as blob if content exceeds BLOB_THRESHOLD; otherwise return as-is. */
export async function maybePutBlob(
  runId: string,
  step: string,
  content: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  if (content.length <= BLOB_THRESHOLD) return content;
  return putBlob(runId, step, content, ttlSeconds);
}
