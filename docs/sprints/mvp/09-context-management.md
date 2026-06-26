# Sprint 09 — Context Management & Compaction

**Status:** DRAFT
**Wave:** 1 — Core Execution Engine
**Depends on:** 04 (loop has the `context.prepare` seam), 06 (the `auto` strategy summarizes via a real `ModelClient`)
**Unblocks:** —

---

## Goal

Implement the `ContextManager` and the default `auto` compaction strategy so the model-visible window is a managed projection — bounded for quality, not just cost — while the full history stays in the event log and compaction is observable via `context.compacted`.

---

## Foundational decisions in play

- [D11](../specs/00-foundations.md#d11--context-is-managed-never-unbounded) — context is managed, never unbounded; the model-visible window is a managed projection; the full history stays in the log and is recoverable.

---

## Scope

**In:**
- **`ContextManager.prepare(messages, ctx)`** invoked at loop step 4 (before each model call), replacing the Sprint 04 identity passthrough.
- **Threshold logic:** if estimated tokens are under the agent's `maxContextTokens` (default ~75% of the model window), pass history through unchanged.
- **Default `auto` `CompactionStrategy`:** over threshold —
  - keep recent turns verbatim;
  - summarize older turns while **preserving decisions and unresolved items**;
  - drop redundant/superseded tool output (e.g. an old file read later re-read);
  - prefer JIT re-retrieval over keeping large blobs resident.
- **Observability + recoverability:** emit `context.compacted { agentName, strategy, beforeTokens, afterTokens }`; the full history remains in the event log (compaction changes only what the *model* sees next).
- **Configuration:** `context: { compaction, maxContextTokens }` frontmatter (parsed in Sprint 02) honored here; `compaction: none` disables; custom strategies via `createRuntime({ contextManager })`.
- **Token estimation** utility used for the threshold (per-model, cheap heuristic acceptable for MVP).

**Out:**
- Persisting a separate "compacted view" store — there is none; the window is recomputed from the log each call.
- Embeddings/vector retrieval for JIT re-retrieval (MVP uses re-read of source via tools / message reconstruction, not a vector index).
- Streaming/`text.delta` interactions (post-MVP).

---

## Deliverables

`@render-agents/engine`:
- `ContextManager` default implementation + `auto` `CompactionStrategy`.
- Token-estimation helper (per-model window sizing → default `maxContextTokens`).
- `context.compacted` emission via `ContextPrepareContext.emit`.
- Wiring into the runtime (`AgentRuntime.contextManager`, overridable).

---

## Porting source

- **New (D11)** — no direct source ([Porting Map](../specs/porting-map.md#1-from-agent-workflows-template-orchestration-kernel)). New code in `@render-agents/engine`. The summarization step itself uses the runtime's `ModelClient` (a cheap tier) to produce summaries.

---

## Implementation notes

1. **`prepare` is pure-ish over the folded history:** it takes the model-visible messages (from `ctx.messages`) and returns a possibly-compacted list; it must not mutate the event log. The full history is always reconstructable from `read()`.
2. **Summarization uses a model call** (likely the `small` tier) — account for its tokens/cost as part of the run (emit an `llm.call`?) or treat as overhead; decide and document (recommend emitting it so cost is attributed and visible).
3. **Decisions/unresolved-items preservation** is the quality-critical heuristic: define what counts (tool decisions, pending approvals, unanswered questions) and keep them verbatim or in the summary header.
4. **Redundant tool-output dropping** keys on superseded reads (same resource re-read later) — use tool-call metadata to detect supersession.
5. **`maxContextTokens` default** derives from the resolved model's context window (~75%); make the window table data-driven alongside `MODEL_PRICING`.

---

## Exit criteria / acceptance

- Under threshold: history passes through unchanged (no `context.compacted` emitted).
- Over threshold: older turns are summarized, recent turns kept verbatim, a superseded large tool output is dropped, and a `context.compacted` event is emitted with accurate before/after token counts.
- Decisions/unresolved items survive compaction (assert via a fixture thread containing a decision + an open question).
- `compaction: none` disables compaction entirely; a custom strategy via `createRuntime({ contextManager })` is used instead of `auto`.
- The full pre-compaction history is still reconstructable from the event log after compaction.

---

## Risks / open questions

- **Summary quality vs determinism:** model-generated summaries are non-deterministic, complicating replay/resume. Since compaction only affects the *next* model input (not the log), resume re-derives the window — but a different summary on resume could change behavior. Decide whether to **persist the summary** (as an event) so resume reuses it deterministically. Recommend persisting the compaction summary in `context.compacted` payload and reusing it on replay.
- **Cost of compaction:** summarization calls add latency/cost; ensure the threshold is high enough that compaction is rare and worth it.
- **Token estimation accuracy:** a cheap heuristic may mis-size the window; over-compaction hurts quality, under-compaction risks provider context-limit errors. Calibrate per provider.
