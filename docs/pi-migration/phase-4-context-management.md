# Phase 4: Context Management via Pi Extensions

## Objective

Replace `DefaultContextManager` + `AutoCompactionStrategy` (222 lines) with Pi's `transformContext` hook on the agent harness, gaining configurable compaction strategies, topic-aware summarization, progressive disclosure, and the ability to use different models for summarization — all without maintaining custom compaction logic.

## Current State

### What exists today

`engine/src/context-manager-impl.ts` (222 lines):
- `estimateTokens()` — character-based token estimation (chars / 4)
- `defaultMaxContextTokens()` — 75% of model context window
- `MODEL_CONTEXT_WINDOWS` — hardcoded window sizes per model
- `AutoCompactionStrategy` — summarize older turns, keep recent 6 turns
- `dropSupersededToolOutputs()` — truncate large tool outputs before summarization
- `DefaultContextManager` — orchestrates threshold check + compaction + event emission

`engine/src/context-manager.ts` (33 lines):
- `ContextManager` interface
- `CompactionStrategy` interface
- `passThroughContextManager` (no-op)

### How it's wired

```
DefaultRunner.run() loop iteration:
  → load history from store
  → contextManager.prepare(messages, ctx)      ← this is where compaction happens
    → estimateTokens(messages)
    → if over threshold: strategy.compact(messages)
      → slice into old + recent
      → summarize old via model call (uses the same ModelClient)
      → emit context.compacted event
    → return compacted messages
  → pass to model.complete/stream
```

### Limitations of current approach

1. **Single summarization model:** Uses the agent's own model for summarization — expensive if the agent runs on Opus
2. **Rigid strategy:** Only one compaction approach (summarize old, keep recent N). No topic-based, no RAG, no sliding window.
3. **No pre-turn injection:** Can't inject dynamic context (e.g., retrieved knowledge) before each turn
4. **Manual token estimation:** `chars / 4` is a rough heuristic; different models have different tokenizers
5. **No progressive disclosure:** Skills are listed in the system prompt unconditionally (busting cache for long catalogs)

## Target State

Pi's harness provides two hooks for context management:

1. **`transformContext`** — called before every model turn. Receives the full message array, can prune/summarize/inject/rewrite. This replaces `ContextManager.prepare()`.

2. **`shouldStop`** — called after each turn. Can trigger compaction proactively (e.g., "compact before next turn if messages exceed X tokens").

Additionally, Pi's extension ecosystem provides community compaction strategies that can be loaded as packages.

### After migration

- `engine/src/context-manager-impl.ts` → **deleted**
- `engine/src/context-manager.ts` → **kept** (interface stays for typing; implementation delegates to Pi)
- Compaction logic moves into the `PiAgentRunner`'s harness config
- Different strategies selected via agent frontmatter: `context.compaction: "auto" | "topic" | "none"`

## Detailed Design

### 1. Pi's `transformContext` as the implementation

```typescript
// In PiAgentRunner, when creating the Agent harness:
const agent = new Agent({
  // ...
  
  transformContext: async (messages, signal) => {
    const tokenEstimate = estimateTokensFromMessages(messages);
    const maxTokens = getMaxContextTokens(agentDef.model, agentDef.context);
    
    if (tokenEstimate <= maxTokens) {
      return messages;  // under budget, pass through
    }
    
    // Over budget: compact
    const compacted = await compactMessages(messages, {
      strategy: agentDef.context?.compaction ?? "auto",
      maxTokens,
      models: this.piModels,  // use a cheap model for summarization
      signal,
    });
    
    // Emit render-factory event for observability
    await ctx.emit({
      type: "context.compacted",
      agentName: agentDef.name,
      strategy: agentDef.context?.compaction ?? "auto",
      beforeTokens: tokenEstimate,
      afterTokens: estimateTokensFromMessages(compacted),
    });
    
    return compacted;
  },
});
```

### 2. Multi-model summarization

The biggest win: compaction can use a *different* (cheaper) model for summarization without plumbing a second `ModelClient`:

```typescript
async function compactMessages(messages, opts) {
  const { strategy, maxTokens, models, signal } = opts;
  
  // Use a small model for summarization (Haiku) regardless of the agent's main model
  const summaryModel = models.getModel("claude-haiku-4-5");
  
  const { recent, older } = splitMessages(messages, RECENT_TURNS_TO_KEEP);
  const summary = await summarizeWithModel(older, summaryModel, models, signal);
  
  return [summaryMessage(summary), ...recent];
}
```

Today this would require constructing a second `ModelClient` and passing it through multiple layers. With `pi-ai`'s `Models` collection, you just pick a different model from the catalog.

### 3. Strategy selection via frontmatter

Agent markdown already has a `context` field:

```yaml
---
context:
  compaction: auto       # or "topic", "sliding", "none"
  maxContextTokens: 100000
---
```

Strategy implementations:

| Strategy | Behavior |
|----------|----------|
| `none` | Pass through (no compaction) |
| `auto` | Current behavior: summarize old, keep recent N turns |
| `topic` | Group messages by topic, summarize each cluster independently |
| `sliding` | Fixed-window: keep last N tokens, drop everything else (no summarization) |

### 4. Dynamic context injection

`transformContext` can also *inject* messages, not just prune:

```typescript
transformContext: async (messages, signal) => {
  // Inject relevant context before the latest user message
  const lastUserMessage = messages.findLast(m => m.role === "user");
  if (lastUserMessage && agentDef.skills?.length) {
    // Example: inject active skill content if it was loaded this session
    const activeSkillContext = getActiveSkillContext();
    if (activeSkillContext) {
      messages = injectBeforeLastUser(messages, activeSkillContext);
    }
  }
  
  // Then do compaction if needed
  return maybeCompact(messages, ...);
}
```

This enables future features like:
- RAG retrieval (query a vector store, inject results)
- Long-term memory (load relevant memories from prior sessions)
- Skill content preloading (inject skill content without a `load_skill` tool call)

### 5. Token estimation upgrade

`pi-ai` has access to provider-specific tokenizer information. We can potentially use it for better estimates:

```typescript
function estimateTokensFromMessages(messages: PiMessage[]): number {
  // If pi-ai provides a token counter for the current model, use it
  // Otherwise fall back to chars/4 heuristic
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
```

**Note:** Exact token counting requires calling the tokenizer (slow for long histories). The heuristic is fine for threshold decisions. We keep it but calibrate the constant per model family if data is available.

### 6. Prompt cache preservation

The current system prompt is pinned with Anthropic's `cache_control: ephemeral`. Compaction must not break this:

- System prompt stays static (cache hit on every turn)
- Compaction only touches the *message* history, never the system prompt
- Progressive skill disclosure (skills in system prompt) already works with caching because the skill list is stable

**Enhancement opportunity:** If compaction changes the first user message (the "summary" message), it invalidates the cache prefix. Solutions:
- Pin the summary as a separate cache-controlled block (provider-specific)
- Keep the summary stable across minor changes (only re-summarize when it's significantly stale)

## Challenges and Assumptions

### C1: Pi's `transformContext` receives Pi-internal messages

**Assumption:** `transformContext` receives the same message format used elsewhere in the harness. We translate render-factory `Message[]` → Pi messages before the harness, so `transformContext` operates on the Pi format.

**Implication:** The compaction logic must work on Pi's message type, not render-factory's `ContentBlock[]`. This is fine — the summarization call goes through `pi-ai` directly.

### C2: Compaction event emission from inside `transformContext`

`transformContext` runs inside the Pi harness. To emit a `context.compacted` event, we need access to `ctx.emit()` from within the hook.

**Solution:** The hook closure captures `ctx` (the `RunContext`), so `emit` is available.

### C3: Compaction produces an invalid message sequence

Anthropic rejects histories where a `tool_result` message doesn't follow the corresponding `tool_use` in an assistant message. Compaction must preserve valid message ordering.

**Current mitigation (preserved):** `AutoCompactionStrategy` snaps the recent-window boundary to an assistant message. The summarized block replaces older messages entirely (as a user-role summary message), so the recent window always starts cleanly.

**With Pi:** Same logic applies. The `transformContext` implementation must ensure the returned message array is a valid conversation history for the provider.

### C4: Compaction mid-run affects budget tracking

If compaction uses a model call (summarization), that call's tokens/cost should be tracked. Currently `DefaultContextManager` calls `model.complete()` and the cost is invisible (not emitted as an `llm.call` event).

**Improvement:** In the new system, emit an `llm.call` event for the summarization call so cost attribution is complete:

```typescript
const summaryResult = await models.streamSimple({ model: summaryModel, ... });
await ctx.emit({
  type: "llm.call",
  model: summaryModel.id,
  usage: summaryResult.usage,
  costUsd: estimateCost(summaryModel.id, summaryResult.usage),
  stopReason: "end_turn",
  latencyMs: elapsed,
});
```

### C5: Testing compaction

Current tests mock `ModelClient` to test compaction. With Pi, tests will:
- Create a mock `Models` collection (or use `pi-ai`'s test utilities)
- Verify that `transformContext` produces valid outputs
- Verify that `context.compacted` events are emitted with correct token counts

## Migration Steps

1. Move `estimateTokens()` and `defaultMaxContextTokens()` to a utility file (these are needed by the compaction logic regardless of where it lives)
2. Implement compaction logic as a standalone function (not a class) that takes `Models` + strategy name
3. Wire `transformContext` in `PiAgentRunner` with the compaction function
4. Add `context.compacted` event emission inside the hook
5. Support strategy selection from agent frontmatter (`context.compaction` field)
6. Add cost tracking for summarization model calls
7. Delete `engine/src/context-manager-impl.ts`
8. Simplify `engine/src/context-manager.ts`: keep interface for backward compat; default impl delegates to Pi
9. Update `sdk/src/runtime.ts`: remove `DefaultContextManager` construction (it's now internal to the runner)
10. Test: long conversation (20+ turns) triggers compaction, events emitted correctly

## Acceptance Criteria

- Long conversations (20+ turns with tool calls) trigger compaction
- `context.compacted` event emitted with accurate before/after token counts
- Summarization uses a cheap model (Haiku) regardless of agent's main model
- Strategy `none` disables compaction (pass through)
- Strategy `auto` behaves identically to current `AutoCompactionStrategy`
- Compaction doesn't break message validity (no provider rejections)
- Summarization cost appears in `llm.call` events (attributable)
- No regression in prompt cache hit rate (system prompt unchanged)
