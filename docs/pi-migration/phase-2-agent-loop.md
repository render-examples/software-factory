# Phase 2: Replace Agent Loop with `@earendil-works/pi-agent-core`

## Objective

Replace `DefaultRunner` (562 lines) — the iterate/call/dispatch loop — with a `PiAgentRunner` that delegates loop mechanics to `pi-agent-core`'s `Agent` harness. render-factory retains ownership of durable event emission, budget enforcement, and subagent delegation.

## Current State

The `DefaultRunner.run()` method does:

1. Build system prompt (with skill catalog)
2. Mount tools (local, MCP, sandbox, subagents)
3. **Loop:**
   a. Check cancellation
   b. Enforce budget (iterations, tokens, cost, wall clock)
   c. Load message history from store
   d. Detect pending tool uses (resume path) → dispatch without re-calling model
   e. Call model (streaming preferred, with cancel polling + delta coalescing)
   f. Emit `llm.call` + `message.assistant`
   g. Extract tool_use blocks → dispatch each tool sequentially
   h. Each tool dispatch: idempotency check → approval gate → validate → invoke → emit events
   i. Emit `message.tool`
4. Terminal: no tool calls → extract text → emit `run.completed`
5. Structured output: retry loop for JSON schema validation
6. Error handling: `RunPaused` propagation, cancel detection, `run.failed`
7. Cleanup: `disposeTools()`

**Responsibilities that move to Pi's harness:**
- The loop itself (iterate until no tools or budget hit)
- Streaming + delta coalescing
- Cancel/abort signal propagation
- Tool dispatch parallelism (currently sequential)
- Pending tool use detection (resume path — Phase 3)

**Responsibilities that stay in render-factory:**
- `ctx.emit(...)` for durable event recording
- Budget enforcement (cost, token, wall-clock — Pi only has thinking budgets)
- Subagent delegation tool source
- Skills (load_skill tool)
- Structured output retry loop
- HITL approval gates (Phase 5 moves these into `beforeToolCall`)

## Target State

```
PiAgentRunner implements AgentRunner {
  run(agent, input, ctx) → AgentOutput
}
```

Internally creates a `pi-agent-core` `Agent` instance configured with:
- `streamFn` → `pi-ai` model stream (from Phase 1's `Models`)
- `tools` → render-factory `Tool[]` wrapped as Pi `AgentTool[]`
- `toolExecution: "parallel"` (upgrade from current sequential dispatch)
- `beforeToolCall` → approval checks, event emission (`tool.called`)
- `afterToolCall` → event emission (`tool.result`)
- `shouldStop` → budget enforcement
- `transformContext` → context management (Phase 4)

## Detailed Design

### 1. Tool translation layer

render-factory tools have this shape:
```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

Pi tools have this shape:
```typescript
interface AgentTool<T> {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;  // TypeBox schema
  execute(args: T, context: ToolCallContext): Promise<ToolCallResult>;
}
```

The adapter:
```typescript
function toPiTool(tool: Tool, rfCtx: RunContext): AgentTool<unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.inputSchema),  // pass JSON Schema through TypeBox
    async execute(args, piCtx) {
      const result = await tool.invoke(args, toolContextFrom(rfCtx, piCtx.toolCallId));
      return {
        content: [{ type: "text", text: result.content }],
        details: { isError: result.isError },
      };
    },
  };
}
```

### 2. Event emission bridge

Pi's harness emits lifecycle events via its telemetry system. We subscribe to these and map to render-factory's `RunEvent`s:

| Pi event | render-factory event |
|----------|---------------------|
| Turn starts / model request | `llm.call` (emitted after response) |
| Text produced | `message.assistant` (emitted at turn end) |
| Tool call starts | `tool.called` |
| Tool call result | `tool.result` |
| Turn ends with no tools | `run.completed` |
| Error | `run.failed` |
| Abort/cancel | `run.cancelled` |

The key difference: Pi's harness may not emit events at the granularity we need for `message.assistant` and `message.tool`. We may need to hook into the harness at multiple points:

```typescript
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  
  beforeToolCall: async ({ toolCall, args }) => {
    await ctx.emit({ type: "tool.called", toolCallId: toolCall.id, name: toolCall.name, input: args });
    // ... approval logic (Phase 5)
  },
  
  afterToolCall: async ({ toolCall, result, isError }) => {
    await ctx.emit({ type: "tool.result", toolCallId: toolCall.id, name: toolCall.name, result: { content: result, isError } });
  },
});
```

For model responses, we capture the full turn output after the model returns:
```typescript
// After each model turn:
await ctx.emit({ type: "llm.call", model, usage, costUsd, stopReason, latencyMs });
await ctx.emit({ type: "message.assistant", agentName: agent.name, content: resultContent });
```

### 3. Budget enforcement via `shouldStop`

Pi's harness checks `shouldStop` before each turn. We use this for budget enforcement:

```typescript
shouldStop: async ({ context }) => {
  iterations++;
  if (iterations > budget.maxIterations) return true;  // or throw
  if (tokensUsed > budget.maxTokens) return true;
  if (budget.maxCostUsd && costUsed > budget.maxCostUsd) return true;
  if (budget.maxWallSeconds && (Date.now() - startedAt) / 1000 > budget.maxWallSeconds) return true;
  return false;
},
```

When `shouldStop` returns true, Pi stops the loop. We then emit `run.failed` with the appropriate budget exhaustion message.

### 4. Streaming deltas

Pi's harness streams via `streamFn` and provides events as the model generates. We tap into these for the `DeltaBus`:

```typescript
// Pi's streamFn already yields text deltas; we intercept them
const wrappedStreamFn = async function*(request) {
  for await (const event of models.streamSimple(request)) {
    if (event.type === "text") {
      ctx.streamDelta(event.text);  // publish to DeltaBus for SSE
    }
    yield event;
  }
};
```

### 5. Parallel tool execution

Currently `DefaultRunner` dispatches tools sequentially (one `dispatchTool` at a time in a `for` loop). Pi's harness supports `toolExecution: "parallel"`. This is a free upgrade:

```typescript
toolExecution: "parallel",  // dispatch all tool calls concurrently
```

For tools that must be sequential (e.g., tools that depend on each other's output within a single turn), the model naturally handles this by issuing them in separate turns.

### 6. Subagent delegation

Subagent tools (`subagents__<name>`) are mounted as regular tools in the Pi harness. They throw `RunPaused` or `RunCancelled` which must propagate out of Pi's tool execution:

```typescript
afterToolCall: async ({ toolCall, result, isError, context }) => {
  // RunPaused / RunCancelled are thrown by the tool.invoke()
  // Pi's harness catches errors from tools — we need them to propagate
  // Solution: re-throw control-flow errors in the afterToolCall hook
}
```

**Challenge:** Pi's harness may catch tool errors and convert them to error results. We need control-flow exceptions (`RunPaused`, `RunCancelled`) to propagate unchanged. Options:
- Use `beforeToolCall` to detect and re-throw from the context
- Set `terminate: true` from `afterToolCall` and re-throw after the harness stops
- Fork the specific tool execution handling (least desirable)

### 7. Structured output

The current `structuredOutput()` method issues additional model calls with `responseFormat` when the agent declares an `output` schema. This logic stays in `PiAgentRunner` but runs *after* the Pi harness completes (the harness runs the tool loop; structured output is a post-processing step):

```typescript
async run(agent, input, ctx): Promise<AgentOutput> {
  // 1. Run Pi harness (handles the full tool loop)
  const result = await this.runHarness(agent, input, ctx);
  
  // 2. If agent has output schema, validate/extract
  if (agent.output) {
    return this.structuredOutput(agent, result, ctx);
  }
  
  return result;
}
```

### 8. Skills (load_skill tool)

The `buildSkillTool()` function creates a virtual tool. This just becomes another tool in the Pi harness's tool array — no special handling needed.

## Challenges and Assumptions

### C1: Pi harness control flow for errors

**Assumption:** Pi's `Agent` harness propagates tool execution errors to the caller (or provides a hook to intercept them before they're caught).

**Risk:** If Pi catches all tool errors and converts them to `{ isError: true }` results, `RunPaused` exceptions won't propagate.

**Mitigation:** Wrap tool execution in the adapter so control-flow exceptions are caught *before* Pi sees them:
```typescript
execute(args, piCtx) {
  try {
    return await tool.invoke(args, rfCtx);
  } catch (err) {
    if (err instanceof RunPaused || err instanceof RunCancelled) {
      // Stash the exception and return a sentinel
      this.pendingControlFlow = err;
      return { content: [{ type: "text", text: "__CONTROL_FLOW__" }], details: { terminate: true } };
    }
    throw err;
  }
}
```
Then after the harness stops, check `pendingControlFlow` and re-throw.

### C2: Message format between Pi's context and our history

Pi maintains its own `AgentMessage[]` internally. We need to:
1. Initialize Pi's messages from our event-log history (for resume)
2. Read Pi's final messages to emit `message.assistant` / `message.tool`

**Assumption:** Pi's `initialState.messages` accepts pre-built history, and `Agent`'s context is readable after execution.

**Mitigation:** If Pi's internal format diverges too much, use `convertToLlm` (a required config function) to keep our `Message[]` as the source of truth and translate on each turn.

### C3: Event ordering guarantees

render-factory's projections depend on events arriving in a specific order (`tool.called` before `tool.result`, `message.assistant` before `message.tool`, etc.). With parallel tool execution, we need to ensure events are emitted in the correct logical order even when tools complete out of order.

**Mitigation:** Buffer tool events and emit them in call-order (matching the order the model requested them), not completion-order.

### C4: Token counting between turns

Budget enforcement tracks cumulative `tokensUsed` and `costUsed` across the loop. Pi's harness provides per-turn usage via the stream response metadata.

**Assumption:** We can access token counts from each `streamSimple` response.

**Mitigation:** `pi-ai` returns `TokenUsage` on every response — verified from the package docs.

### C5: The `callModel` streaming + cancel polling (~100 lines)

This block handles creating an `AbortController`, polling for cancellation every 250ms, and coalescing deltas. Pi's harness handles abort via its signal, so this entire block disappears.

**Assumption:** Pi's harness propagates the `AbortSignal` to the `streamFn`.

**Verification needed:** Confirm Pi's harness accepts and propagates `signal` to cancel in-flight requests.

## Migration Steps

1. Install `@earendil-works/pi-agent-core` in `packages/engine`
2. Create `engine/src/pi-agent-runner.ts` — the new `AgentRunner` implementation
3. Create `engine/src/pi-tool-adapter.ts` — tool translation layer
4. Wire `PiAgentRunner` as the default runner in `sdk/src/runtime.ts`'s `buildRunnerRegistry`
5. Move structured output logic to `PiAgentRunner` (post-harness step)
6. Move skills logic (`buildSkillTool`, `buildSystemPrompt`) to the runner (these stay as-is)
7. Implement event emission bridge (before/afterToolCall hooks + post-turn emission)
8. Implement budget enforcement via `shouldStop` + token/cost accumulation
9. Implement streaming delta bridge (tap `streamFn` for `DeltaBus`)
10. Handle subagent control-flow propagation (sentinel + re-throw pattern)
11. Delete `engine/src/default-runner.ts`
12. Slim `engine/src/run-context.ts`: remove `callModel`, streaming coalescing, cancel polling
13. Update `engine/src/index.ts` exports
14. Run workflow-level integration tests (`spec-to-pr`, `chat-turn`)

## Acceptance Criteria

- All workflow tests pass with identical event sequences
- `chat-turn` workflow streams tokens via SSE (DeltaBus still works)
- Budget enforcement: a run hitting `maxIterations` or `maxCostUsd` fails gracefully
- Subagent delegation: `pr-review` workflow dispatches parallel reviewer `.task()`s correctly
- Tool validation errors produce recoverable `tool.result` (model self-corrects)
- Approval-gated tools still pause (Phase 3/5 will simplify this, but it must still work in Phase 2)
- `toolExecution: "parallel"` produces correct results when multiple tools are called in one turn
