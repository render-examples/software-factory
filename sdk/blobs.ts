/**
 * Blob storage (Redis-backed) for large agent outputs.
 * Outputs exceeding BLOB_THRESHOLD are replaced with `$blob:<key>` refs
 * so workflow subtask payloads stay small. Resolved transparently by agentTask().
 */
import { createHash } from "node:crypto";
import { kv } from "./redis.js";

const REF_PREFIX = "$blob:";
const DEFAULT_TTL_SECONDS = 3600; // 1 hour
export const BLOB_THRESHOLD = 50_000; // characters

const REF_PATTERN = /\$blob:[^\s]+/g;

function blobKey(runId: string, step: string, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `blob:${runId}:${step}:${hash}`;
}

export async function putBlob(
  runId: string,
  step: string,
  content: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const key = blobKey(runId, step, content);
  const client = await kv();
  await client.set(key, content, { EX: ttlSeconds });
  return `${REF_PREFIX}${key}`;
}

export async function getBlob(ref: string): Promise<string | null> {
  const key = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
  const client = await kv();
  return client.get(key);
}

export async function delBlob(ref: string): Promise<void> {
  const key = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
  const client = await kv();
  await client.del(key);
}

/** Replace all `$blob:` refs with their content. Expired refs are left as-is. */
export async function resolveRefs(text: string): Promise<string> {
  const refs = text.match(REF_PATTERN);
  if (!refs) return text;

  const unique = [...new Set(refs)];
  const resolved = await Promise.all(unique.map((r) => getBlob(r)));

  let out = text;
  for (let i = 0; i < unique.length; i++) {
    if (resolved[i] !== null) {
      out = out.replaceAll(unique[i], resolved[i]!);
    }
  }
  return out;
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
