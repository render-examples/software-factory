import { createHash } from "node:crypto";

/**
 * Deterministic key for deduplicating execution against the event log.
 *
 * Two uses share this helper:
 * - Tool-call key: `idempotencyKey(runId, toolCallId)` → SHA-256(runId + toolCallId)
 * - Dispatch key:  `idempotencyKey(runId, agentName + ":" + callSeq)`
 *
 * Both questions ("has this already run?") are answered by a single lookup
 * against the event log, so there is no separate tool-call store.
 */
export function idempotencyKey(runId: string, suffix: string): string {
  return createHash("sha256").update(`${runId}\0${suffix}`).digest("hex");
}
