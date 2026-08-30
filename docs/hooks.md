# Hooks

Event interceptors that let you observe, transform, or veto agent behavior without modifying agent configs or runner code.

## Why

Hooks solve cross-cutting concerns that don't belong in agent prompts or tool implementations:

- **Audit logging** — log every tool call to an external system
- **Cost controls** — reject tool calls that would exceed a budget
- **Redaction** — strip secrets from agent output before it reaches Slack/GitHub
- **Policy enforcement** — block destructive operations (rm -rf, force push)
- **Metrics** — track tool latency, model token usage, error rates

## Design

Two layers, bridged at the runner:

### Layer 1: Framework hooks (SDK-agnostic)

Intercept the `AgentEvent` stream that flows out of every runner. Works with any runner (Claude, Codex, future).

```typescript
// sdk/hooks.ts

type HookResult =
  | { action: "continue"; event?: AgentEvent }   // pass (optionally rewrite)
  | { action: "reject"; reason: string };         // veto (tool events only)

interface HookContext {
  readonly runId: string;
  readonly agentId: string;
}

interface Hook {
  readonly name: string;
  readonly on: AgentEvent["type"][];              // filter by event type
  handle(event: AgentEvent, ctx: HookContext): Promise<HookResult>;
}
```

**Semantics:**
- **Observe**: return `{ action: "continue" }` — side-effect only (logging, metrics)
- **Transform**: return `{ action: "continue", event: rewritten }` — modify before downstream
- **Veto**: return `{ action: "reject", reason }` — block tool_call events only

**Fail policy:**
- Hooks on `tool_call` fail closed (throw → reject)
- All other hooks fail open (throw → continue)

### Layer 2: Claude SDK hooks (runner-specific)

The Claude Agent SDK has 30+ lifecycle hook events (`PreToolUse`, `PostToolUse`, `PreModelSwitch`, etc.) with richer capabilities like input rewriting and permission decisions. These are configured via `Options.hooks` on `query()`.

For Claude-specific needs (input rewriting, permission gating), the `ClaudeRunner` accepts SDK hooks directly:

```typescript
// sdk/runners/claude.ts

export class ClaudeRunner implements AgentRunner {
  constructor(opts?: {
    modelResolver?: ModelResolver;
    hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  }) { ... }
}
```

## Integration Point

Framework hooks wrap the runner's event stream in `agentTask()`:

```typescript
// sdk/agent.ts (simplified)

for await (const event of runner.run(ctx)) {
  const result = await hookInterceptor.intercept(event, { runId, agentId });
  if (result.action === "reject") {
    // feed rejection back as error tool_result
    yield { type: "tool_result", id: event.id, name: event.name,
            content: `Blocked by hook: ${result.reason}`, isError: true };
    continue;
  }
  const finalEvent = result.event ?? event;
  // deliver to caller
}
```

This means hooks see events from ALL runners (Claude, Codex, future) without per-runner wiring.

## Registration

### Programmatic (at startup)

```typescript
// app/src/workflows.ts
import { configure } from "../../sdk/index.js";

configure({
  hooks: [auditHook, costGuardHook, redactSecretsHook],
});
```

### File-based (auto-discovery, future)

```
app/hooks/
├── audit.ts          → export default: Hook
├── cost-guard.ts     → export default: Hook
└── redact-secrets.ts → export default: Hook
```

Discovered at startup by scanning `app/hooks/*.ts`, same pattern as tools.

## Example Hooks

### Audit logger

```typescript
const auditHook: Hook = {
  name: "audit",
  on: ["tool_call", "tool_result", "result"],
  async handle(event, ctx) {
    console.log(JSON.stringify({ hook: "audit", runId: ctx.runId, event }));
    return { action: "continue" };
  },
};
```

### Block destructive commands

```typescript
const blockDestructive: Hook = {
  name: "block-destructive",
  on: ["tool_call"],
  async handle(event, ctx) {
    if (event.type !== "tool_call") return { action: "continue" };
    const input = JSON.stringify(event.input);
    const blocked = ["rm -rf", "git push --force", "DROP TABLE", "DROP DATABASE"];
    for (const pattern of blocked) {
      if (input.includes(pattern)) {
        return { action: "reject", reason: `Blocked destructive operation: ${pattern}` };
      }
    }
    return { action: "continue" };
  },
};
```

### Redact secrets from output

```typescript
const redactSecrets: Hook = {
  name: "redact-secrets",
  on: ["result", "text"],
  async handle(event, ctx) {
    if (event.type === "result") {
      return {
        action: "continue",
        event: { ...event, result: redact(event.result) },
      };
    }
    if (event.type === "text") {
      return {
        action: "continue",
        event: { ...event, text: redact(event.text) },
      };
    }
    return { action: "continue" };
  },
};
```

## Implementation Plan

1. **`sdk/hooks.ts`** — `Hook`, `HookResult`, `HookContext` interfaces + `HookInterceptor` class that runs hooks in registration order
2. **Wire into `agentTask()`** — wrap the runner's event stream with the interceptor
3. **Add `hooks` to `configure()`** — register hooks at startup alongside runner/registry
4. **ClaudeRunner SDK hooks passthrough** — accept `Options.hooks` for Claude-specific lifecycle events
5. **Ship 2-3 example hooks** — audit logger, block-destructive, redact-secrets

## Relationship to Other Systems

- **Permissions & policies** (future-work) build on veto hooks — a policy is just a hook with `on: ["tool_call"]` and reject logic
- **Eval suite** (future-work) builds on observe hooks — record events for later replay/scoring
- **Durability 2.0** — hooks fire on in-memory events before/after steps; the durable log records final (post-hook) state
