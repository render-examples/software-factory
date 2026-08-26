# Phase 3: Checkpoint-Based Pause/Resume

## Objective

Replace the replay-based suspend/resume mechanism (`ReplaySuspender` + deterministic re-execution) with Pi's checkpoint model: save total agent state on pause, restore and continue on resume. Eliminate the determinism contract, memoization infrastructure, and phantom tool re-dispatch.

## Current State

### How pause/resume works today

1. **Pause:** A tool requires approval → `ctx.requestInput()` → emit `input.requested` → `suspender.park()` → `ReplaySuspender` throws `RunPaused` → handler unwinds → `run.paused` emitted → process exits cleanly

2. **Resume:** External POST resolves the input → `input.provided` emitted → the run is **re-executed from the top** → `DefaultRunner.run()` starts again → `hasStarted()` returns true (skip opening events) → loop detects `pendingToolUses()` from the last assistant message → dispatches those tools → `appliedToolResult()` short-circuits already-completed tools → the one that was gated now proceeds with the approval

### Code involved

| File | Lines | What it does for pause/resume |
|------|-------|-------------------------------|
| `engine/src/suspender.ts` | 54 | `Suspender` interface, `ReplaySuspender` (throw `RunPaused`) |
| `engine/src/default-runner.ts` | ~80 | `pendingToolUses()` detection, idempotency check (`appliedToolResult`), `hasStarted()` skip |
| `engine/src/run-context.ts` | ~100 | `requestInput()`, `awaitInput()`, `appliedToolResult()`, `hasStarted()` implementation |
| `sdk/src/native-suspender.ts` | ~60 | Planned `NativeWorkflowsSuspender` (Render Workflows durable pause) |
| `sdk/src/run-in-process.ts` | ~30 | Resume detection, replay dispatch |

### Problems with replay-based resume

1. **Determinism contract:** The entire handler must produce the same event sequence on re-execution. Any non-determinism (timestamps, random IDs, external state changes) breaks replay.
2. **Wasted compute:** On resume, every completed tool is re-dispatched and short-circuited via `appliedToolResult()`. For a run paused after 20 tool calls, that's 20 idempotency checks.
3. **Complexity:** The runner's loop has two entangled paths (fresh execution vs. replay), making changes risky.
4. **Subagent runs:** Child runs dispatched before the pause are memoized via deterministic IDs. If the child run's output format changes between pause and resume, replay may break.

## Target State

### How pause/resume works after migration

1. **Pause:** Tool requires approval → `beforeToolCall` hook fires → emit `input.requested` → **serialize Pi harness state** → store checkpoint in Postgres → emit `run.paused` → harness cleanly stops (no throw, no unwind)

2. **Resume:** External POST resolves the input → load checkpoint from Postgres → **restore Pi harness state** → inject tool result (approved/denied) → harness continues from the exact point of pause → remaining work executes normally

### Key properties

- No re-execution. No determinism contract.
- Resume cost is proportional to *remaining* work, not *total* history.
- The checkpoint is the *complete* state: messages, pending tool calls, budget counters, etc.
- A crash mid-execution is recoverable: load last checkpoint, resume.

## Detailed Design

### 1. Checkpoint storage schema

New Postgres table (not in the event log — checkpoints are ephemeral state, not domain events):

```sql
CREATE TABLE run_checkpoints (
  run_id       TEXT NOT NULL REFERENCES runs(id),
  checkpoint   JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id)
);
```

Single row per run. Overwritten on each checkpoint (Pi's model: "one register, total state"). Deleted when the run reaches a terminal state (completed/failed/cancelled).

For the in-memory store (dev/test), just a `Map<string, unknown>`.

### 2. Checkpoint contents

Pi's `Agent` harness exposes serializable state. The checkpoint includes:

```typescript
interface AgentCheckpoint {
  // Pi harness state (opaque to render-factory)
  harnessState: unknown;
  
  // render-factory bookkeeping
  iterations: number;
  tokensUsed: number;
  costUsed: number;
  runStartedAtMs: number;
  
  // The pending input request that caused the pause
  pendingInputRequestId: string;
  pendingToolCallId: string;
}
```

### 3. `PiCheckpointSuspender` implementation

```typescript
// engine/src/checkpoint-suspender.ts
export class PiCheckpointSuspender implements Suspender {
  constructor(
    private readonly store: CheckpointStore,
    private readonly getHarnessState: () => unknown,
  ) {}

  async park(req: SuspendRequest): Promise<void> {
    const checkpoint: AgentCheckpoint = {
      harnessState: this.getHarnessState(),
      iterations: this.budgetState.iterations,
      tokensUsed: this.budgetState.tokensUsed,
      costUsed: this.budgetState.costUsed,
      runStartedAtMs: this.budgetState.runStartedAtMs,
      pendingInputRequestId: req.inputRequestId,
      pendingToolCallId: req.toolCallId,
    };
    
    await this.store.saveCheckpoint(req.runId, checkpoint);
    // Signal the harness to stop cleanly (no throw)
    this.harnessAbortController.abort();
  }
}
```

### 4. Resume flow

```typescript
// In PiAgentRunner.run():
async run(agent, input, ctx): Promise<AgentOutput> {
  const checkpoint = await this.store.loadCheckpoint(ctx.runId);
  
  if (checkpoint) {
    // RESUME path
    return this.resumeFromCheckpoint(agent, checkpoint, ctx);
  }
  
  // FRESH path
  return this.freshRun(agent, input, ctx);
}

private async resumeFromCheckpoint(agent, checkpoint, ctx): Promise<AgentOutput> {
  // 1. Restore budget state
  this.iterations = checkpoint.iterations;
  this.tokensUsed = checkpoint.tokensUsed;
  this.costUsed = checkpoint.costUsed;
  
  // 2. Read the input resolution
  const resolution = await ctx.getInputResolution(checkpoint.pendingInputRequestId);
  
  // 3. Build the tool result from the resolution
  const toolResult = resolution.approved
    ? await this.executeApprovedTool(checkpoint.pendingToolCallId, agent, ctx)
    : { content: `Denied: ${resolution.reason}`, isError: true };
  
  // 4. Restore Pi harness with the checkpoint state + inject tool result
  const harness = Agent.restore(checkpoint.harnessState, {
    resolvedToolCalls: { [checkpoint.pendingToolCallId]: toolResult },
  });
  
  // 5. Continue execution
  return this.driveHarness(harness, agent, ctx);
}
```

### 5. What gets deleted

| File / code | Action |
|-------------|--------|
| `engine/src/suspender.ts` | Rewrite: delete `ReplaySuspender`, keep `Suspender` interface, add `PiCheckpointSuspender` |
| `default-runner.ts` → `pendingToolUses()` | Delete (no more replay) |
| `default-runner.ts` → `if (pending.length > 0)` block | Delete |
| `run-context.ts` → `appliedToolResult()` | Delete (no more idempotency short-circuit) |
| `run-context.ts` → `hasStarted()` | Simplify (only needed for fresh-vs-resume detection, not for event skip) |
| `sdk/src/native-suspender.ts` | Delete entirely (Pi's checkpoint IS the native suspender) |
| `sdk/src/run-in-process.ts` → replay detection | Remove; resume = load checkpoint |

### 6. Workflow-level `ctx.step()` is unaffected

The workflow handler's `ctx.step(name, fn)` still uses `step.completed` events for memoization. This is **workflow-level** replay (re-driving a workflow handler after crash), not **agent-level** replay. It stays as-is because:
- Workflow handlers are short-lived orchestration steps
- They're deterministic by design (each step is idempotent)
- They're driven by the dispatcher, not the agent loop

The checkpoint model only replaces agent-loop-level pause/resume.

## Challenges and Assumptions

### C1: Pi's harness state serializability

**Assumption:** Pi's `Agent` harness exposes a method to serialize its current state to JSON, and a `restore()` method to reconstruct it.

**Evidence:** Pi's docs describe a "total state" model where `op.state/{operationId}` holds complete state as a single register. The harness-v2 spec says: "Recovery does not replay a journal or infer position from what is missing; it reads that register and switches on it."

**Risk:** Pi may not expose a public `serialize()`/`restore()` API in `pi-agent-core`. It may only support JSONL session persistence.

**Mitigation:** If no public API exists:
- Option A: Use Pi's `SessionManager.custom()` with our Postgres as the backing store
- Option B: Implement our own checkpoint from the messages + pending tool calls (less opaque but more fragile)
- Option C: Contribute the API upstream (Pi is open source)

### C2: Tool result injection on resume

When a tool was blocked for approval, resume needs to inject the result *into* the harness's pending tool batch. Pi's `resume()` handles "unresolved tool batch" by reconciling per-call (skip, re-execute, or synthesize).

**Assumption:** Pi's `resume()` accepts resolved tool results for previously-pending calls.

**Evidence:** harness-v2: "unresolved tool batch → per call: skip, re-execute, or synthesize."

**Mitigation:** If the injection API doesn't exist cleanly, we can model it as: restore state to the point *before* tool dispatch, then re-dispatch with the approval already resolved (similar to current behavior but without full re-execution).

### C3: Crash recovery

If the process crashes mid-execution (not mid-pause), the run is left in "running" status with no checkpoint.

**Current behavior:** The reaper (`reapStaleRuns`) marks these as failed after a timeout.

**With checkpoints:** We could periodically checkpoint during long runs (every N tool calls), enabling crash recovery. However, this is an *enhancement*, not a requirement for Phase 3.

**Decision:** Phase 3 only checkpoints on HITL pause. Crash recovery (periodic checkpoints) is a future enhancement.

### C4: Checkpoint size

A run with 50 tool calls and large tool results could have a substantial message history. The checkpoint includes this (or references it).

**Mitigation:** 
- Message history is already in the event log — the checkpoint can reference it by `(runId, seq)` rather than embedding it
- Only the harness-internal state (pending batch, control registers) needs to be in the checkpoint blob
- Worst case: a few hundred KB of JSON. Postgres JSONB handles this fine.

### C5: Multiple concurrent pauses

A single run can only be paused once at a time (a paused run doesn't continue executing). Multiple HITL gates in sequence (tool A approved → tool B needs approval) are handled as separate pause/resume cycles, each with its own checkpoint overwrite.

**Edge case:** Parallel tool execution where *multiple* tools need approval in the same batch. Options:
- Block the entire batch until all approvals resolve (current behavior: `RunPaused` throws on the first gated tool)
- Allow partial execution: checkpoint captures which tools are pending, resume resolves them all

**Decision:** Keep current behavior (pause on first gated tool). Phase 5 can enhance for batch approvals.

### C6: Interaction with Render Workflows

The `RenderWorkflowsDispatcher` dispatches runs to isolated containers. Today, "resume" means re-dispatching the same task (which re-executes from scratch). With checkpoints:

- The checkpoint is stored in Postgres (accessible from any container)
- Resume dispatches a fresh task that loads the checkpoint and continues
- The Render Workflows task handler detects "this runId has a checkpoint" and takes the resume path

This is cleaner than today's re-execution model and doesn't require any changes to the dispatcher itself.

## Migration Steps

1. Add `CheckpointStore` interface to `packages/store`
2. Implement `PostgresCheckpointStore` (single table)
3. Implement `MemoryCheckpointStore` (for dev/test)
4. Create `engine/src/checkpoint-suspender.ts`
5. Modify `PiAgentRunner` (from Phase 2) to support checkpoint save/restore
6. Implement the resume path: load checkpoint → inject tool result → continue
7. Delete `ReplaySuspender`, `pendingToolUses()`, `appliedToolResult()`, `hasStarted()` workaround
8. Delete `sdk/src/native-suspender.ts`
9. Update `sdk/src/run-in-process.ts`: remove replay detection
10. Update `sdk/src/runtime.ts`: wire `PiCheckpointSuspender` as default
11. Verify workflow-level `ctx.step()` memoization still works (no regression)
12. Test: pause on approval gate → resolve → resume → run completes without re-executing earlier tools

## Acceptance Criteria

- A run paused at tool call #15 resumes without re-executing tools #1-14
- Checkpoint size for a 50-tool-call run is < 500KB
- Resume latency is < 2 seconds (load checkpoint + restore + continue)
- `spec-to-pr` workflow with approval gates works end-to-end
- Crash mid-execution: reaper still marks stale runs as failed (no regression)
- `ctx.step()` in workflow handlers still memoizes correctly (workflow replay unaffected)
- Both in-memory (dev) and Postgres (prod) checkpoint stores work
