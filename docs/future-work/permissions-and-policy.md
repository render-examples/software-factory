# Permissions & Policy System

## Motivation

Today the engine has a minimal approval gate: agents declare `permissions.requireApproval: [tool_name]` in their frontmatter, and a matching tool call pauses the run for human approval. The hook system can veto `tool.called` events via `EventInterceptor`. These are the building blocks, but they don't compose into a real policy system.

Production deployments need:
- **Scoped authority** — an agent should only access what its task requires, not what its credentials allow
- **Delegated identity** — the agent acts on behalf of a user; policies must intersect agent capabilities with user entitlements
- **Runtime narrowing** — once an agent touches sensitive data, its remaining capabilities should shrink (not expand)
- **Deterministic enforcement** — policy is enforced in the runtime, not in the prompt; the model cannot talk its way past it
- **Audit trail** — every policy decision (allow, deny, escalate) is recorded with full context

---

## Industry Survey

### Cloudflare — Agent Access Model (Aug 2026)

Six-component architecture: Access Engine, Identity Broker, Mediation Layer, Trust Ratchet, Agent Activity Log, Grant Review Loop.

Key ideas:
- **Task-scoped credentials**: short-lived tokens minted at dispatch, encoding "agent X, acting for principal H, to do task T." Never reach the model. Expire no later than task completion.
- **Mediation in harness, not prompt**: tool calls checked against policy by a Mediation Layer with default-deny. Outbound traffic forced through network egress control. Two layers fail independently.
- **Trust Ratchet**: stateful one-way narrowing. Once a sensitive read occurs, external destinations are stripped for the remainder of the task. Capability removed mid-task returns only in a newly authorized task.
- **WriteGuard for MCP**: risk tiers per tool (log-only, require-approval, block), attribution labeling, centralized auditing. Policy defined alongside tools without changing the underlying MCP server.
- **Grant Review Loop**: uses activity logs to recommend policy changes. Approved changes apply to future task templates only — never the active task.

### Vercel — Plan-to-Permission Model (2026)

- Agent runs as its own identity (`vercel-agent`), read-only by default.
- For writes or sensitive reads, agent proposes a **plan** with specific permissions needed.
- User approves the plan in one coherent step (not action-by-action).
- Agent gets a **short-lived capability** scoped to that plan. Every call passes three checks: capability, token scope, and team permissions.
- Plan-based, not session-based: each plan is a discrete unit of work. New plan = new authorization, even in the same chat.
- GitHub writes attributed to user ("via Vercel Agent" co-author).
- Enterprise: team owners can disable the agent entirely; audit log records all actions.

### Cursor — Allowlists + Auto-Review Classifier (2026)

Three-layer precedence: team admin dashboard > `permissions.json` > IDE settings.

- **Deterministic allowlists**: `terminalAllowlist`, `mcpAllowlist` — command/tool prefixes that auto-run without approval.
- **Auto-review mode**: LLM classifier gates shell, MCP, and Fetch calls. Steered by `autoRun.allow_instructions` and `block_instructions` (natural language, not enforcement).
- **Explicit non-security-boundary**: Cursor is transparent that allowlists are "best-effort convenience," not a sandbox. The sandbox (OS-level) is the security boundary.
- Per-user (`~/.cursor/permissions.json`) and per-repo (`.cursor/permissions.json`) merge by concatenation.

### OpenAI Codex — Sandbox Modes + Approval Policies (2026)

Two orthogonal axes:
- **Sandbox mode** (OS-level enforcement): `read-only`, `workspace-write` (default), `danger-full-access`. Controls filesystem and network boundaries.
- **Approval policy** (when to pause): `untrusted` (ask for non-trusted commands), `on-request` (ask when leaving sandbox boundary), `never`.
- **Auto-review subagent**: evaluates planned actions and auto-approves low-risk ones, reducing human interruption.
- **Writable roots**: scope write access to specific directories.
- **Command-prefix rules**: allow `npm test` while blocking `docker` and `curl`.
- Enforcement is at OS level (Landlock/seccomp on Linux, sandbox profiles on macOS).

### LangGraph — Auth Handlers + Governance Nodes (2026)

- **Platform-level auth**: `@auth.on` decorator registers handlers for resource-level access (threads, assistants, crons). Handlers return filter dicts or raise 403.
- **In-graph governance nodes**: deterministic gates between agent steps, evaluate policies based on runtime state (cumulative budget, conversation context).
- **ActionBoundary/ActionGate** (proposed): deterministic deny for destructive/provisioning tools regardless of model confidence. Never equate intent to authorization.
- **ActionLedger**: append-only SHA-256 hash-chained JSONL recording tool requests, evaluations, approval receipts.
- Key insight: **perimeter gateway for framework-independent policy + graph-native nodes for state-dependent decisions**.

### OPA / Cedar — Policy-as-Code (General Pattern)

- **Policy Decision Point (PDP)** intercepts every tool call: given principal, actor, tool, arguments, context → allow/deny.
- **Dual-identity propagation**: every request carries both human principal and agent actor; policy evaluates the intersection.
- **OPA (Rego)**: CNCF-graduated, general-purpose, sub-millisecond evaluation as sidecar. Rich data joins, supports batch evaluation.
- **Cedar (AWS)**: constrained grammar, default-deny, forbid-wins-over-permit, no side effects. Used in Amazon Bedrock AgentCore (March 2026).
- **OPAL**: real-time policy/data push to all PDP instances. Critical for revocation-sensitive workloads.
- Deploy OPA as sidecar or host-level daemon (co-located, no network hop for decisions).

---

## Design for render-factory

### Design Principles

1. **Enforcement lives in the runtime, not the prompt.** Policy is checked by the engine before tool invocation. The model's output triggers evaluation but cannot influence the decision.
2. **Default-deny for writes.** Read tools auto-approve; write tools require explicit policy grant or human approval.
3. **Scoped to the task, not the session.** Authority is granted per-run (or per-plan within a run) and expires with it.
4. **Dual identity.** Every policy evaluation receives both the acting agent and the initiating user. The effective capability is the intersection.
5. **One-way narrowing.** Runtime state (sensitive data accessed, budget consumed) can only reduce capabilities, never expand them.
6. **Auditable.** Every decision is logged with full context (who, what, when, result, reason).

---

### Architecture

```
                   ┌─────────────────────────────────────┐
                   │         Policy Configuration        │
                   │  (project.yaml / agent frontmatter) │
                   └──────────────┬──────────────────────┘
                                  │ loaded at boot
                                  ▼
┌──────────┐    ┌──────────────────────────────────┐
│  Agent   │───▶│        Policy Engine (PDP)        │
│  Loop    │    │  evaluate(principal, agent, tool, │
│          │◀───│           input, context)         │
│          │    └──────┬──────────────┬─────────────┘
│          │           │              │
│          │     ┌─────▼────┐  ┌─────▼──────┐
│          │     │  Allow   │  │  Deny /    │
│          │     │(execute) │  │  Escalate  │
│          │     └──────────┘  └────────────┘
│          │                         │
│          │    ┌────────────────────▼──────────────┐
│          │◀───│       Approval / HITL Gate        │
│          │    │  (existing suspender mechanism)   │
│          │    └──────────────────────────────────┘
│          │
│          │    ┌──────────────────────────────────┐
│          │───▶│       Trust Ratchet (state)       │
│          │    │  narrows capabilities mid-run     │
│          │    └──────────────────────────────────┘
│          │
│          │    ┌──────────────────────────────────┐
│          │───▶│       Policy Audit Log            │
│          │    │  append-only decisions record     │
│          │    └──────────────────────────────────┘
└──────────┘
```

---

### Layer 1: Policy Configuration (Static)

Defined in agent frontmatter and/or project-level config. Declarative, version-controlled.

```yaml
# Agent frontmatter (app/agents/implementer.md)
---
permissions:
  requireApproval: [deploy]          # existing — HITL gate
  policy:
    toolAccess:
      sandbox: allow                  # always allowed
      deploy: escalate                # requires approval
      github__delete_repo: deny       # hard deny, no override
    resourceScopes:
      repos: ["org/main-app"]         # can only touch this repo
      environments: ["staging"]       # cannot deploy to production
    riskTier: standard                # low | standard | high | critical
---
```

```yaml
# Project-level policy (project.yaml or policy.yaml)
policy:
  defaults:
    toolAccess: deny                  # default-deny; agents must opt-in
    unknownTools: deny                # model-hallucinated tools are denied
  tiers:
    low:
      maxCostUsd: 1
      requireApproval: []
    standard:
      maxCostUsd: 10
      requireApproval: [deploy, github__push]
    high:
      maxCostUsd: 50
      requireApproval: [deploy, github__push, sandbox__exec]
    critical:
      maxCostUsd: 100
      requireApproval: ["*"]          # everything requires approval
  users:
    - id: "user_abc"
      maxConcurrentRuns: 5
      allowedAgents: ["assistant", "implementer"]
      maxDailyCostUsd: 50
```

### Layer 2: Policy Engine (Runtime PDP)

A synchronous decision point evaluated before every tool invocation:

```typescript
// packages/engine/src/policy.ts

export type PolicyDecision =
  | { effect: "allow" }
  | { effect: "deny"; reason: string }
  | { effect: "escalate"; prompt?: string };  // → HITL gate

export interface PolicyInput {
  principal: Principal;        // the human who initiated
  agent: AgentIdentity;        // which agent is acting
  tool: ToolCall;              // name, input, source
  context: PolicyContext;      // run state, budget consumed, data accessed
}

export interface Principal {
  id: string;
  roles?: string[];
  entitlements?: string[];     // what the user is allowed to do
}

export interface AgentIdentity {
  name: string;
  riskTier: string;
  declaredTools: string[];
  runId: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
  source?: string;             // e.g. "sandbox", "github", "mcp"
}

export interface PolicyContext {
  runId: string;
  threadId?: string;
  iteration: number;
  costSoFar: number;
  tokensSoFar: number;
  sensitiveDataAccessed: string[];  // ratchet state
  elapsedSeconds: number;
  priorDecisions: PolicyDecisionRecord[];  // audit trail
}

export interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}
```

### Layer 3: Built-in Policy Engine (Declarative Rules)

For most deployments, a lightweight built-in engine that evaluates declarative rules without an external dependency:

```typescript
// packages/engine/src/policy-builtin.ts

export class BuiltinPolicyEngine implements PolicyEngine {
  constructor(private rules: PolicyRuleSet) {}

  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    // 1. Hard denies (forbid-wins-over-permit, à la Cedar)
    for (const deny of this.rules.deny) {
      if (matchesRule(deny, input)) {
        return { effect: "deny", reason: deny.reason ?? `Denied by rule: ${deny.id}` };
      }
    }

    // 2. Trust ratchet — check if capability has been narrowed
    const ratchetDeny = this.checkRatchet(input);
    if (ratchetDeny) return ratchetDeny;

    // 3. Escalation rules
    for (const escalate of this.rules.escalate) {
      if (matchesRule(escalate, input)) {
        return { effect: "escalate", prompt: escalate.prompt };
      }
    }

    // 4. Explicit allows
    for (const allow of this.rules.allow) {
      if (matchesRule(allow, input)) {
        return { effect: "allow" };
      }
    }

    // 5. Default (configurable, default-deny recommended)
    return this.rules.defaultEffect ?? { effect: "deny", reason: "No matching policy rule" };
  }
}
```

### Layer 4: External Policy Engine (OPA / Cedar)

For enterprise deployments, delegate to an external PDP:

```typescript
// packages/engine/src/policy-opa.ts

export class OpaPolicyEngine implements PolicyEngine {
  constructor(private opts: { endpoint: string; policyPath: string }) {}

  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    const response = await fetch(`${this.opts.endpoint}/v1/data/${this.opts.policyPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    const { result } = await response.json();
    return result as PolicyDecision;
  }
}
```

OPA policy example (Rego):

```rego
package render_factory.tool_access

import rego.v1

default decision := {"effect": "deny", "reason": "no matching rule"}

# Allow sandbox tools for all agents
decision := {"effect": "allow"} if {
    input.tool.source == "sandbox"
    input.tool.name != "sandbox__terminate"
}

# Deny deploy to production for non-admin users
decision := {"effect": "deny", "reason": "production deploys require admin role"} if {
    input.tool.name == "deploy"
    input.tool.input.environment == "production"
    not "admin" in input.principal.roles
}

# Escalate github pushes for human approval
decision := {"effect": "escalate"} if {
    input.tool.source == "github"
    startswith(input.tool.name, "github__push")
}

# Budget enforcement — deny if cost exceeded
decision := {"effect": "deny", "reason": "cost budget exceeded"} if {
    input.context.costSoFar > data.tiers[input.agent.riskTier].maxCostUsd
}
```

### Layer 5: Trust Ratchet

A one-way state machine that narrows capabilities during a run:

```typescript
// packages/engine/src/trust-ratchet.ts

export interface RatchetRule {
  /** Event that triggers the narrowing. */
  trigger: { toolName?: string; pattern?: string; category?: string };
  /** Capabilities to remove once triggered. */
  revoke: string[];   // tool names or patterns to deny for remainder of run
}

export class TrustRatchet {
  private revoked = new Set<string>();

  constructor(private rules: RatchetRule[]) {}

  /** Called after each tool result. Returns newly revoked capabilities. */
  onToolResult(toolName: string, result: ToolResult): string[] {
    const newlyRevoked: string[] = [];
    for (const rule of this.rules) {
      if (this.matches(rule.trigger, toolName, result)) {
        for (const cap of rule.revoke) {
          if (!this.revoked.has(cap)) {
            this.revoked.add(cap);
            newlyRevoked.push(cap);
          }
        }
      }
    }
    return newlyRevoked;
  }

  isRevoked(toolName: string): boolean {
    if (this.revoked.has(toolName)) return true;
    if (this.revoked.has("*")) return true;
    const source = toolName.split("__")[0];
    return this.revoked.has(source);
  }
}
```

Example ratchet rule: once the agent reads secrets, external network access is revoked:

```yaml
ratchet:
  - trigger: { toolName: "sandbox__exec", pattern: "cat.*\\.env" }
    revoke: ["sandbox__exec_curl", "fetch", "github__push"]
  - trigger: { category: "sensitive_read" }
    revoke: ["*_external"]  # all tools tagged as external
```

### Layer 6: Policy Audit Log

Every decision recorded for compliance and the Grant Review Loop:

```typescript
export interface PolicyDecisionRecord {
  id: string;
  ts: string;
  runId: string;
  agentName: string;
  principalId: string;
  tool: string;
  input: unknown;              // may be redacted for sensitive tools
  decision: PolicyDecision;
  ratchetState: string[];      // current revoked set
  evaluationMs: number;
  policyVersion: string;
}
```

Stored in the existing event log as a new event type:

```typescript
| { type: "policy.evaluated"; tool: string; decision: PolicyDecision; evaluationMs: number; ratchetState: string[] }
```

---

## Integration Into the Engine

The policy engine slots into `dispatchTool` in `default-runner.ts`, between the existing idempotency check and the approval gate:

```typescript
private async dispatchTool(agent, toolUse, mounted, ctx) {
  // 1. Idempotency
  const applied = await ctx.appliedToolResult(toolCallId);
  if (applied) return toolResultBlock(toolCallId, applied);

  // 2. Policy evaluation (NEW)
  const decision = await ctx.evaluatePolicy({
    principal: ctx.principal,
    agent: { name: agent.name, riskTier: agent.permissions?.riskTier ?? "standard", ... },
    tool: { name, input: toolUse.input, source: toolSource(name) },
    context: { runId: ctx.runId, costSoFar: ..., sensitiveDataAccessed: ... },
  });

  if (decision.effect === "deny") {
    const denied = { content: `Denied by policy: ${decision.reason}`, isError: true };
    await ctx.emit({ type: "tool.result", toolCallId, name, result: denied });
    return toolResultBlock(toolCallId, denied);
  }

  // 3. Approval gate (existing, now triggered by "escalate" decisions too)
  if (decision.effect === "escalate" || requiresApproval(agent, name)) {
    const inputGate = await ctx.requestInput(name, toolUse.input, toolCallId);
    // ... existing HITL pause logic
  }

  // 4. Execute tool
  // ...

  // 5. Trust ratchet update (NEW)
  ctx.ratchet.onToolResult(name, result);
}
```

---

## Runtime Wiring

```typescript
export interface RuntimeOptions {
  store: RunStore;
  jobQueue: JobQueue;
  deltaBus: DeltaBus;
  cancelStore: CancelStore;
  blobs?: BlobStore;
  policy?: PolicyEngine;          // ← new, optional (defaults to BuiltinPolicyEngine)
  ratchetRules?: RatchetRule[];   // ← new, optional
}
```

### Factory

```typescript
export function createPolicyEngine(opts?: PolicyEngineOptions): PolicyEngine {
  if (opts?.type === "opa") {
    return new OpaPolicyEngine(opts);
  }
  if (opts?.type === "cedar") {
    return new CedarPolicyEngine(opts);  // future
  }
  return new BuiltinPolicyEngine(opts?.rules ?? defaultRules());
}
```

---

## Comparison Matrix

| Capability | Current State | Proposed |
|-----------|--------------|----------|
| Tool-level approval | `requireApproval` list | Policy engine with allow/deny/escalate |
| Identity-aware | No (agent-only) | Dual identity (principal + agent) |
| Runtime narrowing | No | Trust Ratchet |
| Default posture | Allow (unless gated) | Default-deny for writes |
| External policy engine | No | OPA / Cedar pluggable |
| Audit trail | Events log only | Dedicated `policy.evaluated` events |
| Resource scoping | No | Per-agent resource scopes |
| Budget enforcement | Per-run cost cap | Policy-integrated tier budgets |
| Hook integration | `EventInterceptor` veto | Policy runs before hooks; hooks observe |

---

## Migration Path

The system is **backward-compatible** — existing `requireApproval` continues to work unchanged. The new policy engine is additive:

1. **Phase 1**: Ship `BuiltinPolicyEngine` with declarative rules. `requireApproval` becomes sugar for an `escalate` rule. Zero breaking changes.
2. **Phase 2**: Add Trust Ratchet. Rules are opt-in per agent.
3. **Phase 3**: Wire `PolicyInput.principal` from the gateway's authenticated user. Enable dual-identity evaluation.
4. **Phase 4**: Ship OPA adapter for enterprise deployments.
5. **Phase 5**: Grant Review Loop — analyze audit log to recommend policy tightening/loosening.

---

## Effort Estimate

| Piece | Lines | Time |
|-------|-------|------|
| `PolicyEngine` interface + types | ~80 | 30min |
| `BuiltinPolicyEngine` (rule matching, default-deny) | ~200 | 3hr |
| Integration into `dispatchTool` + `RunContext` | ~80 | 1hr |
| Trust Ratchet | ~120 | 2hr |
| `policy.evaluated` event type + audit | ~40 | 30min |
| Policy configuration loading (frontmatter + project.yaml) | ~100 | 1.5hr |
| OPA adapter | ~60 | 1hr |
| Tests | ~300 | 3hr |

**Total: ~980 lines, ~2-3 days.**

---

## Open Questions

1. **Plan-based vs tool-based approval**: Should we adopt Vercel's "approve the plan" UX (agent proposes a set of actions upfront) in addition to per-tool escalation? Better UX but requires the agent to predict its tool needs.
2. **Policy language**: Start with YAML rules (simple, version-controlled) or jump to a real policy language (Rego/Cedar) from day one?
3. **Ratchet persistence**: Should ratchet state be stored in the event log (replayable) or only in memory (resets on resume)?
4. **Cross-run ratchet**: Should sensitive data access in one run affect sibling runs on the same thread? (Cloudflare says no — each task gets a fresh ceiling.)
5. **Auto-review subagent**: Should we support Codex-style auto-review where a lightweight model evaluates escalated tool calls before bothering the human?
6. **Network policy**: Should we add network-layer enforcement (egress control per agent) or rely solely on tool-level policy? The sandbox already provides OS-level isolation; is that sufficient?
