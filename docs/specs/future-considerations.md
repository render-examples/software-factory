# Future Considerations

**Layer:** Appendix — *forward-looking extensions.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

This appendix collects forward-looking extensions that are deferred beyond MVP but whose seams we want to keep open.

---

## Sandboxes (code execution & development)

[Render Sandboxes](https://render.com/) (forthcoming) are isolated, long-lived execution environments for code generation, testing, and interactive development. The goal is to let an agent check out a repo, run commands, start servers, and iterate — locally identical to production.

**Design principle: a Sandbox is a stateful resource, not a stateless tool.** It is exposed to the *model* as tools, but backed by a runtime-managed resource with an explicit lifecycle. Two orthogonal "compute" concepts must stay distinct:

- **Agent compute** — the container the agent *loop* runs in → already handled by `plan` / `agent.task()` (see [Execution → Run vs task dispatch](02-execution.md#run-vs-task-dispatch)).
- **Sandbox** — the workspace the agent *operates on* (filesystem, exec, ports) → a separate resource driven via tools.

A coding agent runs its loop in a task container but checks out a repo and runs builds *inside a Sandbox*. Different lifetimes, different scaling.

**Proposed seam — `SandboxProvider` on `AgentRuntime`** (optional, env-detected, mirroring `dispatcher`):

```ts
interface AgentRuntime {
  // ...existing...
  readonly sandboxes?: SandboxProvider;
}

interface SandboxProvider {
  acquire(opts: SandboxAcquireOptions): Promise<Sandbox>;
}

interface SandboxAcquireOptions {
  scope: "ephemeral" | "run" | "session";
  /** Key for reattaching a session-pinned sandbox (threadId/sessionId). */
  key?: string;
  /** Optional snapshot to restore from. */
  snapshotId?: string;
  plan?: RenderPlan;
}

interface Sandbox {
  readonly id: string;
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exposePort(port: number): Promise<{ url: string }>;   // preview URLs
  snapshot(): Promise<{ snapshotId: string }>;
  dispose(): Promise<void>;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

**Model-facing surface — a built-in sandbox tool source.** Declared with the existing authoring model (`tools: [sandbox]` → `sandbox__exec`, `sandbox__write_file`, `sandbox__read_file`, `sandbox__expose_port`). It is a `ToolSource` whose `resolve(env)` acquires the sandbox and whose `ResolvedSource.close()` disposes it — so it inherits permissions/HITL (`requireApproval: [sandbox__exec]`), input validation, tracing, and idempotency for free, and is MCP-mirrorable for the Python SDK.

**Context handle.** `ctx.sandbox()` on `ToolContext`/`RunContext` so deterministic `ctx.step()`s and custom tools can use the same sandbox the model is driving (e.g. a `prepare-repo` step clones; the agent then operates on it).

**Scope model:**

| Scope | Lifetime | Use case |
|---|---|---|
| Ephemeral | per tool call | one-off `exec` |
| Run-scoped (default) | acquired on first use, disposed at run end | code review running tests |
| Session-pinned | persisted handle, reattaches across runs | a *development* agent with a durable workspace |

Run-scoped reuse falls out of the `ResolvedSource` lifecycle. Session-pinned requires new state: store the sandbox id (and last snapshot) keyed by `threadId`/`sessionId` in Postgres so the next run reattaches instead of starting clean.

**Sketch:**

```markdown
---
model: claude-sonnet-4-6
tools: [github, sandbox]
permissions:
  requireApproval: [sandbox__exec]
budget:
  maxSandboxSeconds: 1800
---

You are a coding agent. Clone the repo, implement the change, run the tests...
```

### Open questions (Sandboxes)

| # | Question | Options / notes |
|---|---|---|
| S1 | Replay/resume when a sandbox was deprovisioned during a pause | Tool idempotency already prevents re-`exec` on resume, but workspace state may be gone. Use `snapshot()`/restore on resume? Auto-snapshot on pause? |
| S2 | Budget & cost attribution for Sandbox minutes | Add `budget.maxSandboxSeconds` + a sandbox cost line in attribution (Render bills Sandbox minutes). Pricing source? |
| S3 | Secrets/OAuth injection into the sandbox env | How do per-user tokens (`ToolContext.connection`) reach processes running inside the sandbox, safely? |
| S4 | Tracing granularity | Dedicated `sandbox` span kind vs sandbox attributes on `tool` spans (sandbox id, command, exit code). |
| S5 | Cleanup guarantees | Dispose on run completion, cancel, and failure; reconcile orphaned sandboxes (TTL sweeper). |
| S6 | Session-pinned persistence model | Where the reattach handle/snapshot lives (sessions table vs a `sandboxes` table); eviction policy. |
| S7 | Sandbox plan vs agent plan | Does the sandbox get its own `RenderPlan`, independent of the agent's task plan? |
| S8 | Relationship to the `Environment` abstraction | Keep distinct, or unify sandbox handle under [`Environment`](05-type-reference.md#environment)? |

These are deferred until Render Sandboxes is available; the `SandboxProvider` seam and the sandbox tool-source convention are the only commitments needed now to keep MVP work unblocked.
