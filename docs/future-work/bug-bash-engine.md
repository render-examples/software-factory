# Engine Package Audit — Bug Bash 8/30

Audit of `packages/engine/` (29 source files, ~4,700 lines).

## Executive summary

The package has solid baseline structure and all 71 existing tests pass, but the
audit found several production-significant gaps that the current suite does not
exercise:

1. **Policy and approval controls can fail open.** The normal runtime does not
   wire `app/policy.json` into `DefaultRunner`; manually adding a policy disables
   legacy `requireApproval`; invalid policy files become allow-all; and resolved
   credentials are not delivered by `InProcessRunContext`.
2. **Budgets are not durable limits.** Pause/replay resets every counter,
   compaction model calls are unmetered, partial custom pricing disables built-in
   rates, and `maxWallSeconds` does not interrupt in-flight work.
3. **Side effects are at-least-once without a safe claim protocol.** Concurrent
   calls, result-hook failures, task retries, and crashes between invocation and
   `tool.result` can execute the same write more than once.
4. **HTTP and MCP boundaries need hardening.** Cross-origin redirects retain
   credentials, HTTPS IP pinning breaks TLS identity, MCP validation has
   redirect/rebinding gaps, and response-body/cleanup deadlines are incomplete.
5. **Context and structured-output replay can diverge from returned results.**
   Compaction drops tool facts and repeats hidden calls; accepted structured
   output is not persisted as the canonical assistant response.

### Verification

- `pnpm --filter @render-factory/engine test`: **71/71 passed**
- `pnpm --filter @render-factory/engine typecheck`: **passed**
- `pnpm --filter @render-factory/engine build`: **passed**
- `pnpm audit --prod --audit-level moderate`: **no known vulnerabilities**
- `pnpm --filter @render-factory/engine lint`: **fails** at
  `policy-builtin.ts:103` (`no-non-null-assertion`)
- Ten high-impact behaviors below were reproduced with focused runtime probes.

---

## Bugs

### 1. Clarify cancel-scope promise flattening (not a runtime bug)

**File:** `run-context.ts:170–176`

```ts
this.isCancelledFn = async () =>
  (await cancelStore.isCancelled(runId)) || (scopeId ? cancelStore.isCancelled(scopeId) : false);
```

The second `cancelStore.isCancelled(scopeId)` is not explicitly `await`ed.
This is nevertheless correct at runtime: an async function adopts and awaits a
returned promise. Adding `await` would improve clarity and protect against a
future refactor that removes the async return boundary, but this should be
tracked as readability work rather than a cancellation defect.

### 2. `require("yaml")` in an ESM-only package

**File:** `policy-loader.ts:48`

```ts
const yaml = require("yaml");
```

The project is ESM-only (`"type": "module"` in package.json, all imports use
`.js` extensions). Node does not inject a `require` binding into ESM modules;
Node 22's ability for CommonJS code to require some ESM modules does not change
that. The call therefore throws at runtime, `yaml` is not a declared dependency,
and the outer loader catch silently falls back to an empty allow-all policy.
This is currently latent because the normal SDK runtime does not call the
policy loader, but it becomes high severity as soon as policy loading is wired.
Use an ESM import (static or dynamic), declare the dependency, and fail startup
when an existing policy cannot be parsed.

### 3. `structuredOutput` retries don't emit `message.assistant` events

**File:** `default-runner.ts:428–460`

The main loop always emits `message.assistant` after each model call (line 143),
but the `structuredOutput` retry loop only emits `llm.call` — and does so only
after post-call budget checks. The assistant's retry text is never persisted,
including the accepted structured response. This has three consequences:

- a paid retry that crosses a budget is omitted from durable cost accounting;
- a crash can repeat that paid call;
- later chat history contains the original malformed answer even when the API
  returned valid corrected data.

Persist every paid call before enforcing post-call budgets and record the
accepted response as the canonical assistant output.

### 4. Stale imports after constant declarations

**File:** `default-runner.ts:18–19`

```ts
const CANCEL_POLL_MS = 250;
import { validateToolInput } from "./schema-validate.js";
import { ssrfFetch } from "./ssrf-fetch.js";
```

Two `import` statements are placed after constant declarations. While this
compiles (imports are hoisted in ESM), it's misleading and would fail a stricter
linter config. Move these to the top of the file with the other imports.

---

## Security Issues

### 5. SSRF IP-pinning breaks TLS for HTTPS targets

**File:** `ssrf-fetch.ts:170–178`

```ts
if (!isLiteral) {
  headers.set("host", parsed.host);
  pinnedUrl.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
}
```

For HTTPS URLs, rewriting the hostname to the resolved IP sends that IP as the
TLS SNI extension. Node's `fetch` (undici) derives `servername` from the URL
hostname, not the `Host` header. Since TLS certificates are issued for domain
names (not IPs), this will cause certificate validation failures for most HTTPS
endpoints. The `Host` header ensures the correct HTTP/1.1 virtual host, but TLS
handshake negotiation happens before HTTP headers are sent. Needs a custom
`dispatcher` with an explicit `servername` option, or a different pinning
strategy.

### 6. MCP HTTP transport has a TOCTOU gap in SSRF validation

**File:** `mcp-client.ts:247`

`assertUrlAllowed` resolves DNS and validates the IP, but the subsequent `fetch`
re-resolves DNS from the hostname. An attacker controlling the MCP server's DNS
could return a safe IP for the first resolution and a private IP (e.g.
`169.254.169.254`) for the second. The code documents this trade-off ("no
connection-level IP pinning, to preserve TLS SNI") but it leaves cloud-metadata
endpoints reachable via DNS rebinding from operator-configured MCP URLs.

### 7. Approval strictness depends on deployment environment and TTY state

**File:** `run-context.ts:397`

Approval gates auto-approve unless `RENDER_FACTORY_STRICT_APPROVAL` is enabled
or `NODE_ENV` is exactly `production`. A production container that omits
`NODE_ENV` therefore executes gated tools without pausing. When strict mode is
active, a pseudo-TTY takes the local prompt path, which is also unsuitable as a
production authorization boundary.

Default gated tools to strict behavior. Permit auto-approval and TTY prompting
only through explicit development flags.

### 8. Static credential type stores secrets in plaintext

**File:** `policy-builtin.ts:83`

The `static` credential type reads a plaintext value from the policy config file.
While the type definition comments "not recommended for production," there's no
runtime warning logged when this type is used, and no enforcement mechanism to
prevent it in production.

---

## Code Smells & Design Issues

### 9. `InProcessRunContext` — God class

**File:** `run-context.ts` (627 lines)

This class handles event emission, streaming deltas, span correlation,
history/context management, tool mounting/disposal, OAuth token resolution, HITL
approval gates, message input awaiting, and cancel-scope propagation. Each is a
distinct concern. Extracting `SpanCorrelator`, `HitlManager`, `OAuthManager`,
and `DeltaPublisher` collaborators would improve testability and readability.

### 10. Duplicated `shellEscape`

Both `sandbox.ts:120` and `sandbox-tool-source.ts:233` define identical
`shellEscape` functions. Should be a single shared utility.

### 11. Linear `byName` lookups in hot path

**File:** `tool-impl.ts:184`

`MountedTools.byName` does `Array.find()` on every tool dispatch. For agents
with many tools (MCP sources can expose 50+), building a `Map<string, Tool>` at
mount time would give O(1) lookups.

### 12. Mutable `state` bag passed to `structuredOutput`

**File:** `default-runner.ts:396`

The `state` object is mutated in place inside the callee and the effects flow
back to the caller implicitly. A dedicated `BudgetTracker` class with explicit
methods (`track(usage)`, `checkBudget()`) would make the mutation intentional
and self-documenting.

### 13. Hardcoded model pricing table

**File:** `model.ts:51–60`

The pricing table and model context windows (`context-manager-impl.ts:14–23`)
are both hardcoded and change every time a provider updates pricing or releases a
new model. Consider loading from a JSON data file or the factory config so
operators can keep them current without code changes.

### 14. Module-level singleton `warnedModels` never shrinks

**File:** `model.ts:104`

In a long-running server, this `Set` grows unbounded. Similarly, the
`TOKEN_CACHE` in `github-app.ts:22` is a `Map` that never evicts stale entries
for installations that are no longer used.

### 15. Synchronous file reads in policy loader

**File:** `policy-loader.ts:31`

`readFileSync` blocks the event loop. This runs at startup which is acceptable,
but the bare `catch` swallows all errors (including malformed JSON, permission
errors) — only "file not found" should skip to the next candidate.

### 16. Empty `delegation.ts` — over-abstracted

**File:** `delegation.ts` (4 lines)

Exports a single interface with no logic. Should be co-located with
`subagent-source.ts` where it's actually used.

---

## Refactoring Opportunities

### 17. Extract `BudgetTracker`

Budget enforcement logic (iteration counting, token accumulation, cost tracking,
wall-clock checks) is duplicated between `run()` and `structuredOutput()`. A
`BudgetTracker` class with `tick()`, `recordUsage()`, and `check()` methods
would eliminate this duplication.

### 18. Unify context window / pricing data

Both `MODEL_PRICING` in `model.ts` and `MODEL_CONTEXT_WINDOWS` in
`context-manager-impl.ts` are parallel data structures keyed by model string. A
single `ModelRegistry` or data file mapping model → `{ pricing, contextWindow,
provider }` would keep them in sync.

### 19. Make `MountedTools.byName` a `Map`

Replace `Array.find()` with a pre-built `Map<string, Tool>` in
`ToolEnvironment.mount()`. Also simplifies the repeated `.find()` calls in the
fallback path of `InProcessRunContext.mountTools()`.

### 20. Split `DefaultRunner.run()`

The ~170-line method handles resume detection, model calling, budget enforcement,
tool dispatch, structured output, and error classification. Extracting
`resumeOrCallModel()`, `enforceBudgets()`, and `handleCompletion()` would make
the loop body read as a clear pipeline.

---

## Additional Confirmed Runtime and Durability Findings

### 21. Repository policy is not wired into normal execution

**Priority:** High  
**Files:** `default-runner.ts:32–48, 296–329`,
`../sdk/src/runtime.ts:240–246`, `run-context.ts:104–178`

`DefaultRunner` evaluates policy only when `options.policy` is present, but the
normal SDK composition root constructs it with pricing only. `loadPolicyEngine`
has no runtime call site, so `app/policy.json` is currently inert.

Even if a caller injects a policy manually, `InProcessRunContext` does not
provide `principal`, `workflow`, `revokedCapabilities`, or `setCredential`.
Policy receives `iteration: 0` and `costSoFar: 0` for every tool call. As a
result, workflow-specific rules do not select correctly, trust-ratchet state is
absent, stateful cost rules cannot activate, and selected credentials are
discarded.

**Fix:** Load policy at the composition root, make policy identity/state explicit
context dependencies, implement a scoped credential overlay, and emit durable
policy-decision audit events. Until then, remove or clearly mark the inactive
configuration so operators do not treat it as an enforcement boundary.

### 22. Enabling policy disables existing `requireApproval` gates

**Priority:** Medium while policy is unwired; High once enabled  
**File:** `default-runner.ts:296–341`

The legacy approval branch is guarded by `!this.options.policy`. Adding any
policy engine—even an allow-all engine used only for credential routing—skips
frontmatter `permissions.requireApproval`.

The policy design describes one canonical policy source, so replacing the
legacy gate may be intentional migration behavior. It is still hazardous today:
the public agent configuration and backward-compatibility plan continue to
expose `requireApproval`, and injecting policy silently changes that behavior.
The normal SDK runtime currently injects no policy, so this path is latent.

This was reproduced with strict approval enabled: adding an empty policy caused
a gated deploy tool to execute without emitting `input.requested`.

The built-in policy also returns `allow` when a configured credential ID is
unknown or its environment variable is missing. A tool can then fall back to an
ambient, more privileged credential.

**Fix:** Require approval when either policy escalates _or_
`requiresApproval()` matches. Treat configured-but-unresolvable credentials as
configuration failures or deny decisions.

### 23. Pause/replay resets every cumulative budget

**Priority:** High  
**File:** `default-runner.ts:52–65, 122–148, 473–481`

`iterations`, `tokensUsed`, `costUsed`, returned `usage`, and `runStartedAt`
start over on every `run()` invocation. `hasStarted()` suppresses only the
opening events; it does not restore the ledger from prior `llm.call` events.

This was reproduced with `maxTokens: 3`: the run paused, resumed, consumed four
durable tokens, completed successfully, and returned usage for only the final
two.

**Fix:** Hydrate counters and the original start/deadline from durable run
projections before replay. Returned usage must be cumulative for the entire run.

### 24. `maxWallSeconds` is not an execution deadline

**Priority:** High  
**File:** `default-runner.ts:93–99, 200–250, 428–449`

Wall time is checked only before an iteration. It does not abort model calls,
context preparation, policy evaluation, tools, MCP requests, or structured
output retries, and a final result is not checked again before
`run.completed`.

This was reproduced with a 1 ms budget: a response arriving roughly 34 ms later
was recorded as successful.

**Fix:** Derive one absolute run deadline, combine it with caller/cancel-store
signals, propagate it through every awaited operation, and check cancellation
immediately before durable assistant and terminal events.

### 25. Partial custom pricing disables built-in cost accounting

**Priority:** High  
**Files:** `model.ts:71–79`, `default-runner.ts:124–127, 439–441`

Passing a custom pricing object replaces the default argument to `estimateCost`;
it is not layered over `MODEL_PRICING` as the documentation states. Adding a
rate for one private model therefore makes every unlisted built-in model cost
zero and disables `maxCostUsd` for those models.

**Fix:** Merge `{ ...MODEL_PRICING, ...customPricing }` once during runtime
construction. If a finite cost limit exists and a model remains unpriced, fail
closed or require an explicit opt-out.

### 26. Tool idempotency is a non-atomic check-then-act

**Priority:** High  
**File:** `default-runner.ts:290–294, 360–380`

The runner checks `appliedToolResult`, emits `tool.called`, invokes the external
action, and appends `tool.result` as separate operations. Two workers—or two
parallel blocks with the same model-supplied tool-call ID—can both see no result
and both execute.

This was reproduced with two same-ID `tool_use` blocks: the write tool ran twice
and two results were appended.

A process crash after the external side effect but before `tool.result` has the
same ambiguity.

**Fix:** Atomically claim `(runId, toolCallId)` before invocation, use leases for
crash recovery, and require downstream idempotency keys for side-effecting
providers. Indeterminate calls should be reconciled, not blindly replayed.

### 27. Parallel tool dispatch is not structured concurrency

**Priority:** High  
**File:** `default-runner.ts:259–275, 296–319`

`Promise.all` rejects as soon as one tool throws `RunPaused` or `RunCancelled`,
but siblings continue running. The runner then enters `finally` and can dispose
their shared MCP environment while they are still using it.

Policy escalation is discovered inside each tool task, after
`dispatchToolsParallel` decides whether the batch is gated. A dynamically
escalated call can therefore park while sibling writes remain in flight.

**Fix:** Validate and pre-evaluate the complete batch, reject duplicate IDs,
reserve calls before execution, cancel siblings on control-flow errors, and await
all settlements before cleanup.

### 28. Result hooks can cause successful side effects to replay

**Priority:** High  
**Files:** `hook-adapter.ts:5–18, 50–73`,
`default-runner.ts:360–380`

The entire `tool` event category is treated as fail-closed, including
`tool.result`. If a category hook throws or rejects after a tool succeeds, the
side effect has happened but no canonical result is stored. Replay sees no
result and invokes the tool again.

This was reproduced by rejecting `tool.result`: the same write executed twice
across replay.

**Fix:** Permit veto only for the pre-execution `tool.called` event. Terminal
result persistence must be non-vetoable; post-execution observers should fail
open or use a separate outbox.

### 29. Multiple `awaitInput()` points shift answers on replay

**Priority:** Medium (latent; there are currently no production call sites)  
**File:** `run-context.ts:454–552`

Input consumption is tracked in an in-memory `Set`, while replay starts by
selecting the latest resolved request. A reconstructed context does not know
which await point it is replaying.

This was reproduced with two inputs: after resolving `"first"` and `"second"`,
a fresh replay returned `"second"` from the first `awaitInput()` call and then
created a spurious third request.

**Fix:** Assign a deterministic durable ordinal or call-site key to each await
point and resolve that exact ID during replay.

### 30. Context compaction is lossy, unmetered, and repeatedly recomputed

**Priority:** High  
**Files:** `context-manager-impl.ts:79–169, 180–208`,
`run-context.ts:300–314`

The summarizer serializes only `text` blocks. Historical `tool_use` names and
arguments and `tool_result` content become blank transcript entries, despite
`dropSupersededToolOutputs` preparing those results for bounded inclusion.

Compaction calls the model outside normal `llm.call` accounting and does not
persist a checkpoint. Every later over-threshold loop iteration reloads the full
history and pays to summarize it again, potentially using the agent's expensive
primary model.

Histories of six or fewer messages are returned unchanged even if one message is
larger than the model window, and the compacted result has no enforced
`afterTokens <= maxTokens` postcondition.

**Fix:** Serialize bounded representations of every content-block type, persist
compaction checkpoints by transcript revision, account summarizer usage through
the normal model-call path, and deterministically trim until the full request
fits.

### 31. Exceptional model stop reasons are marked successful

**Priority:** High  
**Files:** `default-runner.ts:132–163`,
`clients/anthropic-client.ts:93–98`,
`clients/openai-client.ts:49–68`

The runner logs `stopReason` but considers any response without `tool_use`
complete. A `max_tokens` response containing half a patch is therefore emitted
as `run.completed`. Anthropic collapses several exceptional reasons into
`end_turn`, while OpenAI refusal content is ignored and can become an empty
successful response.

**Fix:** Define a typed stop-reason contract and explicitly continue, fail, or
surface refusal for truncation, content filtering, pause/continuation, context
exhaustion, and unknown reasons.

### 32. Opening events are outside the runner's failure boundary

**Priority:** Medium  
**File:** `default-runner.ts:52–66, 484–487`

`run.started`, `message.user`, and object-input serialization occur before the
main `try/catch`. If `run.started` succeeds but user-message serialization or
append fails, no `run.failed` event is recorded. Replay sees `hasStarted()` and
skips repairing the missing user turn.

A cyclic object or `BigInt` can trigger this partial state through the public
in-process API.

**Fix:** Validate/serialize input first and atomically append the opening pair,
or detect and repair each opening event independently inside the guarded
lifecycle.

---

## Additional Provider and Accounting Findings

### 33. Missing explicit API-key overrides fall back to global credentials

**Priority:** High  
**Files:** `clients/index.ts:25–37`,
`clients/openai-client.ts:23–28`,
`clients/anthropic-client.ts:13–19`

When an explicitly configured `apiKeyEnv` is absent, `readEnv()` returns
`undefined`. `OpenAIClient` then reads `OPENAI_API_KEY`; the Anthropic SDK
similarly falls back to `ANTHROPIC_API_KEY`.

An agent intended to use a tenant-specific key can silently run and bill against
the platform-wide credential.

**Fix:** Distinguish "no override requested" from "explicit override missing."
The latter must fail. Keyless custom endpoints should require an explicit mode.

### 34. Missing or malformed OpenAI response fields fail open

**Priority:** High  
**File:** `clients/openai-client.ts:40–67, 76–116, 151–159`

Absent usage is normalized to zero. This is common among nominally compatible
endpoints that ignore `stream_options.include_usage`, and it bypasses token and
cost budgets.

Malformed tool arguments are converted to `{ _raw: ... }`; a permissive
`{ type: "object" }` tool schema accepts that object and invokes the tool.
Refusal fields are discarded.

**Fix:** Represent missing usage as unknown and fail closed or estimate
conservatively for budgeted runs. Convert malformed tool arguments into an error
tool result, and preserve provider refusal information.

### 35. Provider retries multiply unexpectedly

**Priority:** Medium  
**Files:** `clients/index.ts:15–21`, `clients/retry.ts:22–78, 108–132`

Both installed SDK clients retain their default retry loops, then `withRetry`
adds an outer loop. One logical model call can issue up to twelve HTTP attempts.
The outer `Retry-After` parser treats headers as a plain object, while SDK errors
typically expose a Web `Headers` instance.

**Fix:** Choose one retry owner. If the engine wrapper remains, construct SDK
clients with retries disabled, parse `Headers.get()` and `retry-after-ms`, and
bound all attempts by the run deadline.

### 36. Cache-token accounting is incomplete

**Priority:** Medium  
**Files:** `default-runner.ts:124–131, 439–444`,
`clients/anthropic-client.ts:80–90`,
`clients/openai-client.ts:59–62`

`addUsage` computes cache fields, but the runner copies only `inputTokens` and
`outputTokens` back into returned usage. Token limits also omit Anthropic cache
read/write categories. OpenAI cached-token details are not normalized, so cost
is charged as ordinary input.

**Fix:** Define canonical usage semantics, retain the complete merged
`TokenUsage`, and include all processed-token categories in budget and pricing
calculations.

### 37. Model capabilities are inferred from name prefixes

**Priority:** Medium  
**Files:** `tiers.ts:21–25`,
`clients/openai-client.ts:121–145`,
`clients/anthropic-client.ts:137–149`

Prefix routing cannot describe parameter, schema, or content-block capabilities:

- `o1`, `o3`, and newer reasoning models are routed to OpenAI, but
  `maxOutputTokens` is emitted as incompatible `max_tokens`;
- arbitrary "OpenAI-compatible" endpoints receive strict `json_schema` even
  when they support only `json_object` or prompt steering;
- unsupported Anthropic content blocks are converted to placeholder text rather
  than round-tripped, which can break signed thinking/tool continuations.

**Fix:** Introduce a provider/model capability registry covering endpoint,
parameters, structured-output dialect, tool support, content blocks, context
window, and pricing. Reject unsupported combinations at load time.

---

## Additional Security and Resource Findings

### 38. Cross-origin redirects retain credentials and request bodies

**Priority:** High  
**File:** `ssrf-fetch.ts:151–200`

Manual redirect handling reuses the original headers, method, and body for every
3xx response. A trusted API with an open redirect can send `Authorization`,
cookies, custom API keys, or a POST body to an attacker-controlled public host.

This was reproduced: both `Authorization` and `X-API-Key` remained present after
a redirect between two public IP origins.

**Fix:** Follow only actual redirect statuses, implement Fetch method/body
semantics, strip credential-bearing headers whenever origin changes, and cancel
each redirect response body.

### 39. HTTP deadlines end when headers arrive

**Priority:** High  
**Files:** `ssrf-fetch.ts:162–190, 210–243`,
`mcp-client.ts:247–264, 277–312`

Both transports clear their timer once `fetch()` returns response headers.
Subsequent streamed body reads have no total or idle deadline. MCP's SSE parser
waits for EOF even though a valid SSE connection can remain open after emitting
the matching response. Session DELETE has no timeout.

**Fix:** Keep a combined total/idle deadline through body consumption, parse SSE
incrementally until the matching JSON-RPC response arrives, and bound teardown.

### 40. MCP stdio lifecycle and isolation are incomplete

**Priority:** High  
**File:** `mcp-client.ts:10–28, 112–207`

- stdout accumulates without a frame-size cap until a newline appears;
- failed initialization rejects before any owner can close the child;
- `close()` sends SIGTERM but neither awaits exit nor escalates;
- the process shares the host user, repository working directory, filesystem,
  and network, while `HOME` remains available.

Filtering environment variables is useful but does not sandbox a compromised
third-party MCP package.

**Fix:** Bound protocol frames, close on every initialization failure, await
exit with SIGKILL fallback, propagate cancellation, and run untrusted stdio MCP
servers under an isolated user/sandbox with restricted mounts and egress.

### 41. Tool inputs and outputs are persisted without redaction

**Priority:** High  
**Files:** `default-runner.ts:56–59, 137–143, 353–380`,
`run-context.ts:212–227, 256–276, 417–419`

Raw user input, tool arguments, approval payloads, errors, and results flow into
the event store and external tracer. Tokens, passwords, signed URLs, or sensitive
API responses can therefore remain in durable history and observability exports.

**Fix:** Add centralized schema-aware redaction before persistence and tracing.
Keep necessary sensitive artifacts in encrypted, access-controlled storage and
store only references in the event log.

### 42. Sandbox output limits apply after unbounded buffering

**Priority:** High  
**Files:** `sandbox.ts:70–79`,
`sandbox-tool-source.ts:69–72, 94–123, 221–229`

`collectExecOutput` stores every chunk and joins the complete string before
`truncate()` runs. A model-controlled `yes` loop, large file, or huge directory
can exhaust the worker heap before the nominal 50,000-character cap applies.

**Fix:** Enforce byte and time limits while consuming events, cancel execution
when the cap is reached, and optionally spill full output to bounded artifact
storage.

### 43. Concurrent `apply_patch` calls share a temporary filename

**Priority:** Medium  
**File:** `sandbox-tool-source.ts:185–199`

Every call writes `/tmp/.render-agent.patch`, and cleanup runs only after a
successful `git apply`. Concurrent calls in one sandbox can overwrite, apply,
or remove one another's patch; failures leave potentially sensitive diffs.

**Fix:** Use a tool-call-specific random path and remove it unconditionally in a
`finally` block.

### 44. Subagent fanout enforcement has a TOCTOU race

**Priority:** High  
**File:** `subagent-source.ts:63–89`

Fanout count checking and dispatch/increment are separate operations. Parallel
subagent tools can all read the same old value and exceed `maxFanout`; the SDK's
execution-local counter also resets on replay.

This was reproduced with `maxFanout: 1`: two parallel calls both dispatched.

**Fix:** Atomically reserve fanout in durable run state before dispatch and
reconstruct reservations from `subagent.spawned` events.

### 45. Streaming and tool-environment lifecycle state is not replay-safe

**Priority:** Medium  
**Files:** `run-context.ts:130–134, 230–243`,
`tool-impl.ts:112–194`

A slow `DeltaBus` creates an unbounded promise chain; completion does not await
the publish tail, and delta sequence numbers restart when a context is rebuilt
after pause. Separately, a `ToolEnvironment` reused after `dispose()` never
closes newly mounted sources because its `disposed` flag remains true.

Selective tool IDs also use `split("__")[1]`, so a valid tool name containing a
second `__` cannot be mounted.

**Fix:** Add bounded delta backpressure and a replay epoch, flush before terminal
events, make `ToolEnvironment` explicitly single-use or reset its lifecycle
state, and split names only at the first separator.

### 46. Sandbox IDs are ambient capabilities

**Priority:** Medium  
**File:** `sandbox-tool-source.ts:24–31, 94–99`

Every model-supplied `sandbox_id` is passed directly to
`provider.connect(sandboxId)` without run/user ownership validation. Security
therefore depends entirely on IDs remaining secret and on provider-side checks
that are not represented in the interface.

**Fix:** Bind allowed sandbox IDs to a run/user or replace raw IDs with scoped,
expiring capability handles validated before every operation.

---

## Missing Tests

The green suite does not cover the highest-risk paths above. Add focused tests
for:

1. cumulative token, cost, iteration, and wall-clock budgets across pause/replay;
2. `requireApproval` with and without an injected policy and with unset
   `NODE_ENV`;
3. malformed/unreadable JSON policy and YAML loading;
4. workflow-specific deny/escalate rules and scoped credential delivery;
5. concurrent same-ID tool calls and concurrent resumes;
6. a paused tool alongside a delayed sibling write;
7. rejection/throw during `tool.result`;
8. multiple `awaitInput()` points with a fresh context for every replay;
9. compaction accounting, memoization, tool-result retention, and oversized
   short histories;
10. structured-output budget overrun and canonical accepted transcript;
11. truncation, refusal, pause, context exhaustion, and unknown stop reasons;
12. missing/malformed provider usage and malformed streamed tool calls;
13. cross-origin redirect credential stripping, HTTPS hostname pinning, DNS
    rebinding, and slow response bodies;
14. MCP initialization failure, oversized stdio frames, cancellation, and
    teardown deadlines;
15. bounded sandbox output, concurrent patch calls, and sandbox ownership;
16. atomic subagent fanout and replayed fanout state.

---

## Recommended Remediation Sequence

1. **Restore trustworthy controls:** wire policy, make invalid policy fatal,
   compose approval gates, and fail unresolved credential bindings.
2. **Create one durable execution ledger:** centralize cumulative budgets,
   deadlines, cancellation, model-call persistence, and returned usage.
3. **Make side-effect execution claim-based:** atomically reserve tool calls and
   fanout, require downstream idempotency keys, and make result persistence
   non-vetoable.
4. **Harden transport boundaries:** fix redirect credential handling and TLS
   pinning; close MCP rebinding, body-timeout, subprocess, and cleanup gaps.
5. **Persist canonical context:** checkpoint compaction and accepted structured
   output, preserving bounded tool facts.
6. **Add a model capability registry:** unify routing, parameters, structured
   output, content blocks, context windows, and pricing.
7. **Split orchestration concerns:** extract `BudgetTracker`/model executor,
   tool dispatcher, HITL manager, span correlator, credential broker, and delta
   publisher from `DefaultRunner` and `InProcessRunContext`.

---
