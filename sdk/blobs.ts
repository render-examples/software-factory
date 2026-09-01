/**
 * Store-backed handoff artifacts for large agent outputs.
 * Oversized results become opaque `$blob:blob:<key>` refs that workflow code
 * resolves explicitly; user-authored text is never scanned for references.
 */
import { factoryStore, isArtifactRef } from "#factory/store";

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // Match run checkpoints.
export const BLOB_THRESHOLD = 50_000; // characters

export function isBlobRef(value: string): boolean {
  return isArtifactRef(value);
}

export async function putBlob(
  runId: string,
  step: string,
  content: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  return factoryStore().artifacts.put({
    runId,
    namespace: step,
    content,
    ttlSeconds,
  });
}

export async function getBlob(ref: string): Promise<string | null> {
  if (!isBlobRef(ref)) return null;
  return (
    await factoryStore().artifacts.get(ref, DEFAULT_TTL_SECONDS)
  )?.content ?? null;
}

export async function delBlob(ref: string): Promise<void> {
  if (!isBlobRef(ref)) return;
  await factoryStore().artifacts.delete(ref);
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
