# Workflows Durability 2.0 Integration

How Render Workflows durability primitives (`workflow()`, `ctx.step()`, `ctx.sleep()`, `ctx.waitForEvent()`) integrate with the agent factory.

## Current State

Workflows are plain `task()` functions that `await` subtasks directly. No durability between steps — if the process dies mid-implementation, everything reruns from scratch including expensive agent calls.

## With Durability

Each workflow phase becomes a `ctx.step()`. Completed steps replay from the durable log instead of re-executing.

```typescript
// Before
export const specToPr = task({ name: "spec-to-pr" }, async (input) => {
  const sandbox = await provider.create();
  const research = await researchTask({...});
  const plan = await planTask({...});
  const impl = await implementTask({...});   // if crash here, all lost
  await gh.ensurePull(...);
});

// After
export const specToPr = workflow({ name: "spec-to-pr" }, async (ctx, input) => {
  const sandboxId = await ctx.step("create-sandbox", () => provider.create({...}));
  const research = await ctx.step("research", () => researchTask({...}));
  const plan = await ctx.step("plan", () => planTask({...}));
  const impl = await ctx.step("implement", () => implementTask({...}));
  await ctx.step("push", () => sandbox.exec("git push ..."));
  await ctx.step("open-pr", () => gh.ensurePull(...));
  await ctx.step("cleanup", () => sandbox.terminate());
});
```

On crash during `implement`, replay returns cached results for `create-sandbox`, `research`, and `plan` from the durable log. Only `implement` re-executes.

## What Each Primitive Unlocks

| Primitive | Agent Factory Use Case |
|-----------|----------------------|
| `ctx.step()` | Each agent phase is durable — no wasted compute on replay |
| `ctx.sleep()` | Scheduled follow-ups ("re-review 1 hour after deploy") |
| `ctx.dispatch()` | Fan-out PR reviewers as tracked subtasks |
| `ctx.waitForEvent()` | HITL approval gates — pause after plan, resume on user approval |

## HITL Approval Flow (requires signals)

```typescript
const plan = await ctx.step("plan", () => planTask({...}));
await ctx.step("notify", () => postSlack("Plan ready — reply 'approve' to proceed"));
await ctx.waitForEvent("plan-approved");   // workflow pauses here
await ctx.step("implement", () => implementTask({...}));
```

The Slack handler sends the signal when the user replies. The workflow resumes from exactly where it paused.

## What Changes in Our Code

| Layer | Change | Effort |
|-------|--------|--------|
| `app/workflows/*.ts` | `task()` → `workflow()`, `await` → `ctx.step()` | Mechanical refactor |
| `sdk/blobs.ts` | Less critical — durable log handles large payloads (Cassandra <250KB, S3 for larger) | May remove or keep as fast cache |
| `sdk/sandbox.ts` | Add reconnect-or-recreate pattern — on replay, cached sandbox ID may have timed out | Small |
| `sdk/runner.ts` | No change — durability is at the workflow layer, not the agent execution layer | None |
| `app/gateway/slack.ts` | Add signal dispatch for HITL approval replies | When signals ship |

## Integration Sequence

1. **`workflow()` + `ctx.step()` ships**: Refactor all workflows. Each `await` wraps in `ctx.step("name", ...)`. Verify replay skips completed steps.
2. **`ctx.sleep()` ships**: Add scheduled follow-ups (re-review after deploy, remind on stale PRs).
3. **`ctx.waitForEvent()` ships**: Add HITL approval gates in spec-to-pr and pr-review.

## Sandbox Lifecycle on Replay

On replay, `ctx.step("create-sandbox")` returns the cached sandbox ID from the durable log. But the sandbox may have timed out. The `RenderSandboxProvider.connect()` should handle this:

```typescript
async connect(sandboxId: string): Promise<Sandbox> {
  const sandbox = new RenderSandbox(this.client, sandboxId, this.ownerId);
  const status = await sandbox.status();
  if (status === "terminated" || status === "errored") {
    // Sandbox expired — recreate with same config
    return this.create(originalOpts);
  }
  return sandbox;
}
```

This requires storing creation options alongside the sandbox ID in the step output, or passing them through the workflow context.
