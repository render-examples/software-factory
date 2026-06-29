import type { RunStore } from "./run-store.js";

/**
 * All-in cost for a run: its own `totalCostUsd` plus every subagent descendant's
 * (discovered by following `subagent.spawned.childRunId` across runs). Per-run
 * `totalCostUsd` stays a pure fold; cross-run delegation cost is a read-layer
 * aggregate (Foundations → Subagent delegation). Cycle-guarded.
 */
export async function aggregateRunCost(store: RunStore, runId: string): Promise<number> {
  const total = await sum(store, runId, new Set<string>());
  return Math.round(total * 1e12) / 1e12;
}

async function sum(store: RunStore, runId: string, seen: Set<string>): Promise<number> {
  if (seen.has(runId)) return 0;
  seen.add(runId);
  const run = await store.getRun(runId);
  let total = run?.totalCostUsd ?? 0;
  const events = await store.events.read(runId);
  for (const e of events) {
    if (e.payload.type === "subagent.spawned") {
      total += await sum(store, e.payload.childRunId, seen);
    }
  }
  return total;
}
