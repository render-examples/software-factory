# Sprint 07 — Tool System, Environment, Dispatch Sequence, SSRF Fetch

**Status:** DRAFT
**Wave:** 1 — Core Execution Engine
**Depends on:** 02 (tool discovery/registry), 04 (loop + RunContext)
**Unblocks:** 08 (`load_skill` invoke uses the dispatch path), 13 (HITL gates real tools), 14 (subagents are a tool source), 15 (hook veto on `tool.called`), 19 (OAuth via ToolContext)

---

## Goal

Implement the full tool system: `defineTool`/`defineMcpSource`, single/multi/MCP source shapes, the environment that mounts/disposes tools, the `ToolContext` (env, logger, OAuth `connection`, SSRF-guarded `fetch`), and the ordered **tool dispatch sequence** (idempotency → approval gate → lookup → validate → emit `tool.called` → invoke → emit `tool.result` → wrap) with error containment.

---

## Foundational decisions in play

- [D6](../specs/00-foundations.md#d6--tools-are-declared-per-agent-tools-is-the-sole-allowlist-mcp-at-the-boundary) — `tools[]` is the sole allowlist; only declared tools are mounted/presented; MCP at the boundary.
- [D7](../specs/00-foundations.md#d7--hitl-pause-is-a-control-flow-signal-resolved-by-replay) — the approval gate is step 2 of dispatch (mechanics deferred to Sprint 13; the seam is wired here).

---

## Scope

**In:**
- **`defineTool(spec)`** → single-tool `ToolSource` (model-facing name = source id) and array export → multi-tool source (`sourceId__toolName`).
- **`defineMcpSource(spec)`** → MCP-backed source over `stdio`/`http` transport; remote tools namespaced `sourceId__toolName`; the MCP-advertised input schema is used for validation.
- **`Environment` + `mount`/`dispose`** ([Type Reference → Environment/MountedTools/ResolvedSource](../specs/05-type-reference.md#environment)): resolve declared sources, produce a `MountedTools` map keyed by model-facing name, and dispose cleanly (close MCP connections).
- **`RunContext.mountTools(toolIds)`** real implementation (replaces the Sprint 04 passthrough): mounts exactly the agent's declared `tools[]` (expanded), plus the built-in `load_skill` when skills are declared (skill *content* loading is Sprint 08; the tool plumbing is here).
- **`ToolContext`:** `env`, `signal`, `logger`, `connection(provider)` (returns `undefined` until OAuth lands in Sprint 19 — interface wired now), and **SSRF-guarded `fetch`**.
- **SSRF-guarded fetch:** DNS-resolve + private-IP/internal-range/metadata-endpoint block, redirect re-check, size/timeout caps.
- **The ordered dispatch sequence** from [Execution → Tool dispatch](../specs/02-execution.md#tool-dispatch), replacing the Sprint 04 minimal dispatch:
  1. idempotency check (`ctx.appliedToolResult`) → short-circuit;
  2. approval gate (`ctx.requestApproval`) — seam wired, full pause/resume in Sprint 13;
  3. lookup (unknown tool → error result);
  4. validate input vs `inputSchema` (local + MCP) → error `tool_result` on failure (no crash);
  5. emit `tool.called` → invoke;
  6. emit `tool.result`;
  7. wrap as `tool_result` block.
- **Error containment:** thrown tool errors become `{ isError: true }` results; the loop never crashes.
- **Collision enforcement** at mount/load: cross-source model-facing name collisions and the reserved `load_skill` name are hard errors (validated in Sprint 02; enforced again at mount).

**Out:**
- HITL pause/resume + denial replay (Sprint 13) — here the gate calls `ctx.requestApproval` and handles approve/deny-inline; pause throws are Sprint 13.
- OAuth token resolution behind `connection()` (Sprint 19) — returns `undefined` for now.
- Skill `content` retrieval semantics (Sprint 08) — `load_skill` is mounted here, its invoke body lands with skills.
- Subagent tool source (`subagents__<name>`) (Sprint 14) — built atop this dispatch path.
- Parallel tool dispatch (future optimization) — dispatch stays sequential.

---

## Deliverables

`@render-agents/engine` (+ `sdk` re-exports of authoring helpers):
- `defineTool`, `defineMcpSource` (in `sdk` surface; impl may live in engine).
- MCP client/transport integration (`@modelcontextprotocol/sdk` or equivalent) with schema fetch + namespacing.
- `Environment` with `mount`/`dispose`; `MountedTools`.
- `ToolContext` impl incl. SSRF `fetch`.
- The dispatch sequence as a function the loop calls per `tool_use`.

---

## Porting source

- **T — Tool system:** `agent-workflows-template/src/engine/tool.ts`, `tools.ts`, `types/tool.ts` — direct lift for `defineTool`/`ToolSource`/registry; add `defineMcpSource` and `ConnectorSpec` support (connectors consumed in Sprint 20).
- **T — Environment:** `agent-workflows-template/src/engine/environment.ts`, `types/environment.ts` — direct lift for mount/dispose.
- **H — SSRF-guarded fetch:** `render-agent-harness/.../core/src/builtins/fetchUrl.ts` — direct lift into `engine`: DNS resolve + private-IP block via `ipaddr.js`, redirect re-check, size/timeout caps.
- **H — Idempotent tool dispatch:** `core/src/idempotency.ts` — keep the key `SHA-256(runId + toolCallId)`, but check/record via the event log (`appliedToolResult` reads `tool.result`); no separate idempotency store.

---

## Implementation notes

1. **Dispatch is the one ordered sequence** — wire it as a single function so idempotency/approval/validation/tracing/error-containment are uniform across local, MCP, `load_skill`, and (later) subagent tools.
2. **`tools[]` is the sole allowlist:** only declared/expanded tools are mounted and presented as `ToolSchema`s to the model; a model hallucinating an undeclared tool hits the "unknown tool" error path.
3. **MCP at the boundary:** validate the model's input against the **MCP-advertised** schema; on failure return an error `tool_result` so the model can self-correct. Dispose connections on environment teardown.
4. **`requireApproval` matches expanded names** (e.g. `github__merge_pr`). The gate seam calls `ctx.requestApproval(name, input)`; in Wave 1 the in-process auto-approve path (Sprint 04) handles it; Sprint 13 adds pause/deny.
5. **SSRF fetch is the only network primitive given to tools** — document that tools should use `ctx.fetch`, not raw `fetch`, so the guard isn't bypassed.

---

## Exit criteria / acceptance

- Single-tool, multi-tool, and MCP sources mount with correct model-facing names; collisions and the reserved `load_skill` name are hard errors.
- The dispatch sequence is exercised end-to-end: idempotent short-circuit on a repeated `toolCallId`; unknown-tool error; schema-validation error returned to the model (no crash); successful invoke emits `tool.called`+`tool.result`.
- A thrown error inside a tool becomes an `isError` result; the loop continues.
- SSRF fetch blocks `169.254.169.254`, private ranges, and DNS-rebinding redirects; enforces size/timeout caps.
- MCP tool input is validated against the server-advertised schema; connections dispose on teardown.

---

## Risks / open questions

- **MCP transport surface:** stdio vs http lifecycle, auth headers (`headers()` thunk), and reconnection — scope MVP to launch-on-mount/close-on-dispose; defer pooling.
- **Approval-gate seam vs Sprint 13:** keep the gate call site stable so Sprint 13 only changes `requestApproval` behavior (pause/throw), not the dispatch sequence.
- **`connection()` returning `undefined` pre-OAuth:** OAuth-dependent tools must return a clear error result rather than throwing — document this contract for tool authors now.
- **Schema validation library:** reuse the loader's validator (Sprint 02) or a fast JSON-schema validator (Ajv) in the hot path; measure against the < 10ms/turn loop overhead NFR.
