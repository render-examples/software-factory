# Phase 5: HITL Tool Interception via `beforeToolCall`

## Objective

Move the HITL approval logic out of the agent loop's sequential dispatch path and into Pi's `beforeToolCall` hook. Integrate with the checkpoint-based pause/resume from Phase 3 so the entire approval → pause → resume flow is handled declaratively in a single hook, eliminating the custom interleaving of approval gates, exception throwing, and replay detection.

## Current State

### How approval works today (in `DefaultRunner.dispatchTool`)

```typescript
// Step 2 of dispatchTool():
if (requiresApproval(agent, name)) {
  const inputGate = await ctx.requestInput(name, toolUse.input, toolCallId);
  if ("status" in inputGate) {
    // Pending: throw RunPaused to unwind the handler
    throw new RunPaused(ctx.runId, "input", [inputGate.inputRequestId]);
  }
  if (inputGate.approved === false) {
    const denied: ToolResult = { content: `Tool call denied: ${inputGate.reason}`, isError: true };
    await ctx.emit({ type: "tool.result", toolCallId, name, result: denied });
    return toolResultBlock(toolCallId, denied);
  }
}
```

This is interleaved with:
- Idempotency checks (step 1: `appliedToolResult()`)
- Tool lookup (step 3)
- Input validation (step 4)
- Actual dispatch (step 5)
- Event gate hooks (step 5: `EventRejectedError`)

### Problems

1. **Tight coupling:** Approval logic is embedded in the dispatch path, making it hard to reason about independently.
2. **Exception-driven control flow:** `RunPaused` thrown mid-dispatch unwinds the entire call stack. The runner must catch and handle it specially.
3. **Sequential only:** If two tools in the same turn need approval, the second is never reached (first throws `RunPaused`). After resume, the second tool goes through the same cycle.
4. **Replay overhead:** On resume, all earlier tools in the batch go through `appliedToolResult()` checks before reaching the one that was gated.

## Target State

After Phase 5, the approval flow lives entirely in Pi's `beforeToolCall` hook:

```typescript
beforeToolCall: async ({ toolCall, args, context }) => {
  // 1. Check if this tool needs approval
  if (!requiresApproval(agentDef, toolCall.name)) {
    return undefined;  // allow
  }
  
  // 2. Check if already approved (resume case)
  const existing = await ctx.getInputResolution(toolCall.id);
  if (existing?.status === "approved") return undefined;  // allow
  if (existing?.status === "denied") {
    return { block: true, reason: existing.reason, terminate: false };
  }
  
  // 3. Request approval (fresh case)
  const inputRequestId = generateInputRequestId(ctx.runId, toolCall.id);
  await ctx.emit({
    type: "input.requested",
    inputRequestId,
    kind: "approval",
    toolName: toolCall.name,
    input: args,
  });
  
  // 4. Checkpoint and pause
  await suspender.park({
    runId: ctx.runId,
    inputRequestId,
    kind: "approval",
    toolCallId: toolCall.id,
  });
  
  // 5. After resume: suspender.park() resolved, read the decision
  const resolution = await ctx.getInputResolution(inputRequestId);
  if (!resolution || !resolution.approved) {
    return { block: true, reason: resolution?.reason ?? "denied", terminate: false };
  }
  
  return undefined;  // approved, continue
}
```

### What's different

- No `RunPaused` exception. The pause is handled *inside* the hook via the checkpoint suspender.
- No replay. Resume continues from the checkpoint; the hook returns the decision directly.
- The runner loop has zero awareness of approvals — it's just another hook.
- Multiple approvals in a batch can be handled (request all, wait for all).

## Detailed Design

### 1. Hook integration with checkpoint suspend

The `beforeToolCall` hook in Pi's harness runs before each tool is executed. When it needs to pause:

```
beforeToolCall fires → emit input.requested → checkpoint state → abort harness
                                                                       ↓
[time passes — human approves/denies]
                                                                       ↓
resume: load checkpoint → harness restarts → beforeToolCall fires again
  → read resolution from store → return allow/block
```

The key insight: on resume, `beforeToolCall` fires again for the same tool (because the harness restored to the pre-tool state). But now the resolution exists in the store, so it returns immediately.

### 2. Batch approval (enhancement over current)

Currently, if one turn produces `[tool_A (gated), tool_B (gated), tool_C (ungated)]`, execution pauses at `tool_A` and never reaches `tool_B`. After resuming `tool_A`, execution continues to `tool_B` and pauses again.

With `beforeToolCall` and parallel tool execution, we can handle this better:

**Option A (simple, matches current behavior):** `toolExecution: "one-at-a-time"` for gated tools. Each tool is checked before execution. If blocked, checkpoint and pause. Same behavior as today, just implemented more cleanly.

**Option B (enhanced):** Request all approvals upfront, pause once, resume when all are resolved:

```typescript
beforeToolCall: async ({ toolCall, args, context }) => {
  if (!requiresApproval(agentDef, toolCall.name)) return undefined;
  
  const resolution = await ctx.getInputResolution(toolCall.id);
  if (resolution) {
    return resolution.approved ? undefined : { block: true, reason: resolution.reason };
  }
  
  // No resolution yet — request it and checkpoint
  await requestAndPause(toolCall, args);
}
```

With parallel execution, all gated tools in a batch fire `beforeToolCall`. Each requests approval if not yet resolved. The last one triggers the checkpoint. On resume, all resolutions are available.

**Decision:** Implement Option A first (matches current behavior). Option B is a future enhancement.

### 3. `afterToolCall` for event emission

Currently, `tool.called` and `tool.result` events are emitted by `dispatchTool()`. With Pi's hooks:

```typescript
beforeToolCall: async ({ toolCall, args }) => {
  // Emit tool.called (after approval passes)
  await ctx.emit({ type: "tool.called", toolCallId: toolCall.id, name: toolCall.name, input: args });
  // ... approval logic
},

afterToolCall: async ({ toolCall, result, isError }) => {
  await ctx.emit({
    type: "tool.result",
    toolCallId: toolCall.id,
    name: toolCall.name,
    result: { content: resultToString(result), isError },
  });
},
```

### 4. Policy hooks (EventInterceptor)

The current system has `EventInterceptor` that can reject `tool.called` events (policy veto). With `beforeToolCall`:

```typescript
beforeToolCall: async ({ toolCall, args }) => {
  // Check policy (replaces EventInterceptor for tool gates)
  const policyResult = await checkPolicy(toolCall.name, args);
  if (policyResult.blocked) {
    return { block: true, reason: policyResult.reason, terminate: false };
  }
  
  // ... rest of approval logic
}
```

The `EventInterceptor` mechanism stays for non-tool events but is no longer the mechanism for tool gating.

### 5. `awaitInput` (message-type HITL)

Beyond approval gates, render-factory has "message" type inputs (`kind: "message"`) where the agent asks the human a question and pauses for their response. This uses the same mechanism:

```typescript
// A tool that requests human input:
async invoke(input, toolCtx) {
  const inputRequestId = generateId();
  await ctx.emit({
    type: "input.requested",
    inputRequestId,
    kind: "message",
    prompt: input.question,
  });
  
  await suspender.park({ runId: ctx.runId, inputRequestId, kind: "message" });
  
  // After resume:
  const response = await ctx.getInputResolution(inputRequestId);
  return { content: response.value };
}
```

This pattern stays the same — it's a tool that pauses for input. The only change is that `park()` now checkpoints instead of throwing.

### 6. What gets deleted/simplified

| Code | Action |
|------|--------|
| `DefaultRunner.dispatchTool()` approval gate block | Delete — moved to `beforeToolCall` |
| `requiresApproval()` function | Move to a utility (still needed) |
| `RunPaused` throw in dispatch context | Delete — `park()` no longer throws |
| `run-context.ts` → `requestInput()` | Simplify — just emits events + delegates to suspender |
| `run-context.ts` → `awaitInput()` | Simplify — delegates to suspender |
| `pendingToolUses()` in runner | Already deleted in Phase 3 |
| `appliedToolResult()` in context | Already deleted in Phase 3 |

## Challenges and Assumptions

### C1: Pi's `beforeToolCall` return type

**Assumption:** Pi's `beforeToolCall` can return:
- `undefined` / nothing → allow the tool call
- `{ block: true, reason, terminate }` → block with error result

**Evidence:** From Pi's docs: `beforeToolCall: async ({ toolCall, args, context }) => { return { block: true, reason: "bash is disabled", terminate: true } }`

**Confirmed.**

### C2: Async operations in `beforeToolCall`

**Assumption:** `beforeToolCall` is `async` and can perform I/O (store reads, event emission, suspension).

**Risk:** If Pi expects `beforeToolCall` to be fast/synchronous, checkpoint operations would need to happen elsewhere.

**Evidence:** Pi's examples show `async` handlers. The harness `await`s the hook before proceeding.

**Confirmed.**

### C3: Subagent `RunPaused` propagation

Subagent tools can throw `RunPaused` (when the *child* run pauses for HITL). This needs to propagate to the parent.

**In the new model:** The subagent tool's `invoke()` throws → caught in the tool adapter → checkpoint the *parent* harness → parent pauses. On resume, the parent resumes → subagent tool is re-invoked (child was independently resumed) → child result returned.

**Complication:** The parent checkpoints at the point where the subagent tool is executing. On resume, it re-invokes the subagent tool. The subagent run has completed in the meantime (independently resumed). So re-invocation needs to detect "this subagent run already completed" and return its result.

**Mitigation:** The subagent tool already has this: it checks `memoizedChildOutput` in the dispatcher. This mechanism stays — it's part of the SDK's dispatch layer, not the agent loop.

### C4: `terminate` vs. `block` semantics

Pi's `beforeToolCall` distinguishes:
- `block: true, terminate: false` → tool returns an error result, but the harness continues (model can try again or proceed differently)
- `block: true, terminate: true` → tool blocked AND the entire run stops

For approval denial, we want `terminate: false` (the model should be told the tool was denied and allowed to continue with alternatives). For policy violations that indicate the model is off-track, `terminate: true` might be appropriate.

**Decision:** Denial → `terminate: false`. Policy veto → configurable (default `false`).

### C5: Race condition: approval arrives before checkpoint completes

If the human approves *very* quickly (before the checkpoint is written to Postgres), the system must handle this gracefully.

**Mitigation:** The `park()` operation is:
1. Emit `input.requested`
2. Write checkpoint
3. Emit `run.paused`
4. Stop harness

If approval arrives between steps 1 and 2, the `input.provided` event is written to the log. On resume (which must happen after the checkpoint is written), the `beforeToolCall` hook reads the resolution and returns immediately. No race condition — the resolution is checked fresh on every `beforeToolCall` invocation.

### C6: Testing approval flows

Tests need to:
1. Start a run with an approval-gated tool
2. Verify `input.requested` event is emitted
3. Resolve the input externally
4. Verify the run resumes and completes

This is the same test pattern as today, just without the replay machinery. Tests become simpler because there's no "re-execute from top" to verify.

## Migration Steps

1. Implement `beforeToolCall` hook in `PiAgentRunner` with approval logic
2. Implement `afterToolCall` hook with event emission
3. Move `requiresApproval()` to a utility module
4. Remove approval gate code from the old dispatch path (already deleted with `DefaultRunner`)
5. Simplify `run-context.ts`: `requestInput()` becomes a thin event emitter + suspender call
6. Integrate policy checks (`EventInterceptor` for tools) into `beforeToolCall`
7. Test: single approval gate → pause → resume → complete
8. Test: denied approval → tool error result → model adapts
9. Test: multiple sequential approval gates in a run
10. Test: subagent pause propagation to parent

## Acceptance Criteria

- Approval-gated tools pause the run (checkpoint saved)
- Approved tools execute normally after resume
- Denied tools produce error results; model continues
- Multiple approval gates in a single run work (sequential pause/resume cycles)
- Policy vetoes (EventInterceptor) still block tools with error results
- Subagent `RunPaused` propagates to parent correctly
- No `RunPaused` exception thrown anywhere in the agent loop (clean control flow)
- `input.requested` / `input.provided` events emitted correctly (projections build)
- Operator UI still shows pending approvals and allows resolution
- `message`-type HITL (ask-human tools) works via the same checkpoint mechanism
