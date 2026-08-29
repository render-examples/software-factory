# Engine Package Audit — Bug Bash 8/30

Audit of `packages/engine/` (29 source files, ~4,700 lines).

## Executive summary

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

---

## Bugs

### 1. `require("yaml")` in an ESM-only package

**Priority:** High (latent; becomes blocking when policy loading is wired)
**File:** `policy-loader.ts:48`

```ts
const yaml = require("yaml");
```

The project is ESM-only (`"type": "module"` in package.json, all imports use
`.js` extensions). Node does not inject a `require` binding into ESM modules;
Node 22's ability for CommonJS code to require some ESM modules does not change
that. The call therefore throws at runtime, `yaml` is not a declared dependency,
and the outer loader catch silently falls back to an empty allow-all policy.

Use an ESM import (static or dynamic), declare the dependency, and fail startup
when an existing policy cannot be parsed.

### 2. `structuredOutput` retries don't emit `message.assistant` events

**Priority:** High
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

### 3. Exceptional model stop reasons are marked successful

**Priority:** High
**Files:** `default-runner.ts:132–163`,
`clients/anthropic-client.ts:93–98`,
`clients/openai-client.ts:49–68`

The runner logs `stopReason` but considers any response without `tool_use`
complete. A `max_tokens` response containing half a patch is therefore emitted
as `run.completed`. Anthropic collapses several exceptional reasons into
`end_turn`, while OpenAI refusal content is ignored and can become an empty
successful response.

Define a typed stop-reason contract and explicitly continue, fail, or
surface refusal for truncation, content filtering, pause/continuation, context
exhaustion, and unknown reasons.

### 4. Opening events are outside the runner's failure boundary

**Priority:** Medium
**File:** `default-runner.ts:52–66, 484–487`

`run.started`, `message.user`, and object-input serialization occur before the
main `try/catch`. If `run.started` succeeds but user-message serialization or
append fails, no `run.failed` event is recorded. Replay sees `hasStarted()` and
skips repairing the missing user turn.

A cyclic object or `BigInt` can trigger this partial state through the public
in-process API.

Validate/serialize input first and atomically append the opening pair,
or detect and repair each opening event independently inside the guarded
lifecycle.

---

## Security Issues

### 5. SSRF IP-pinning breaks TLS for HTTPS targets

**Priority:** High
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
endpoints. Needs a custom `dispatcher` with an explicit `servername` option, or
a different pinning strategy.

### 6. MCP HTTP transport has a TOCTOU gap in SSRF validation

**Priority:** High
**File:** `mcp-client.ts:247`

`assertUrlAllowed` resolves DNS and validates the IP, but the subsequent `fetch`
re-resolves DNS from the hostname. An attacker controlling the MCP server's DNS
could return a safe IP for the first resolution and a private IP (e.g.
`169.254.169.254`) for the second. The code documents this trade-off ("no
connection-level IP pinning, to preserve TLS SNI") but it leaves cloud-metadata
endpoints reachable via DNS rebinding from operator-configured MCP URLs.

### 7. Approval strictness depends on deployment environment and TTY state

**Priority:** High
**File:** `run-context.ts:397`

Approval gates auto-approve unless `RENDER_FACTORY_STRICT_APPROVAL` is enabled
or `NODE_ENV` is exactly `production`. A production container that omits
`NODE_ENV` therefore executes gated tools without pausing. When strict mode is
active, a pseudo-TTY takes the local prompt path, which is also unsuitable as a
production authorization boundary.

Default gated tools to strict behavior. Permit auto-approval and TTY prompting
only through explicit development flags.

### 8. Static credential type stores secrets in plaintext

**Priority:** Medium
**File:** `policy-builtin.ts:83`

The `static` credential type reads a plaintext value from the policy config file.
There's no runtime warning logged when this type is used, and no enforcement
mechanism to prevent it in production.

---

## Runtime & Durability Findings

### 9. Repository policy is not wired into normal execution

**Priority:** High
**Files:** `default-runner.ts:32–48, 296–329`,
`../sdk/src/runtime.ts:240–246`, `run-context.ts:104–178`

`DefaultRunner` evaluates policy only when `options.policy` is present, but the
normal SDK composition root constructs it with pricing only. `loadPolicyEngine`
has no runtime call site, so `app/policy.json` is currently inert.

Even if a caller injects a policy manually, `InProcessRunContext` does not
provide `principal`, `workflow`, `revokedCapabilities`, or `setCredential`.
Policy receives `iteration: 0` and `costSoFar: 0` for every tool call.

Load policy at the composition root, make policy identity/state explicit
context dependencies, implement a scoped credential overlay, and emit durable
policy-decision audit events.

### 10. Enabling policy disables existing `requireApproval` gates

**Priority:** Medium (latent); High once policy is enabled
**File:** `default-runner.ts:296–341`

The legacy approval branch is guarded by `!this.options.policy`. Adding any
policy engine — even an allow-all engine used only for credential routing —
skips frontmatter `permissions.requireApproval`.

Reproduced: with strict approval enabled, adding an empty policy caused
a gated deploy tool to execute without emitting `input.requested`.

The built-in policy also returns `allow` when a configured credential ID is
unknown or its environment variable is missing, allowing fallback to a more
privileged ambient credential.

Require approval when either policy escalates _or_ `requiresApproval()` matches.
Treat configured-but-unresolvable credentials as deny decisions.

### 11. Pause/replay resets every cumulative budget

**Priority:** High
**File:** `default-runner.ts:52–65, 122–148, 473–481`

`iterations`, `tokensUsed`, `costUsed`, returned `usage`, and `runStartedAt`
start over on every `run()` invocation. `hasStarted()` suppresses only the
opening events; it does not restore the ledger from prior `llm.call` events.

Reproduced: with `maxTokens: 3`, the run paused, resumed, consumed four
durable tokens, completed, and returned usage for only the final two.

Hydrate counters and the original start/deadline from durable run projections
before replay.

### 12. `maxWallSeconds` is not an execution deadline

**Priority:** High
**File:** `default-runner.ts:93–99, 200–250, 428–449`

Wall time is checked only before an iteration. It does not abort model calls,
context preparation, policy evaluation, tools, MCP requests, or structured
output retries.

Reproduced: a 1ms budget allowed a response arriving ~34ms later to record as
successful.

Derive one absolute run deadline, combine it with caller/cancel-store signals,
and propagate it through every awaited operation.

### 13. Partial custom pricing disables built-in cost accounting

**Priority:** High
**Files:** `model.ts:71–79`, `default-runner.ts:124–127, 439–441`

Passing a custom pricing object replaces the default argument to `estimateCost`;
it is not layered over `MODEL_PRICING` as documented. Adding a rate for one
private model therefore makes every unlisted built-in model cost zero and
disables `maxCostUsd` for those models.

Merge `{ ...MODEL_PRICING, ...customPricing }` once during runtime construction.

### 14. Tool idempotency is a non-atomic check-then-act

**Priority:** High
**File:** `default-runner.ts:290–294, 360–380`

The runner checks `appliedToolResult`, emits `tool.called`, invokes the external
action, and appends `tool.result` as separate operations. Two workers — or two
parallel blocks with the same model-supplied tool-call ID — can both see no
result and both execute.

Reproduced: two same-ID `tool_use` blocks caused the write tool to run twice
and two results were appended.

Atomically claim `(runId, toolCallId)` before invocation and require downstream
idempotency keys for side-effecting providers.

### 15. Parallel tool dispatch is not structured concurrency

**Priority:** High
**File:** `default-runner.ts:259–275, 296–319`

`Promise.all` rejects as soon as one tool throws `RunPaused` or `RunCancelled`,
but siblings continue running. The runner then enters `finally` and can dispose
their shared MCP environment while they are still using it.

Policy escalation is discovered inside each tool task, after
`dispatchToolsParallel` decides whether the batch is gated. A dynamically
escalated call can park while sibling writes remain in flight.

Validate the complete batch, reserve calls before execution, cancel siblings on
control-flow errors, and await all settlements before cleanup.

### 16. Result hooks can cause successful side effects to replay

**Priority:** High
**Files:** `hook-adapter.ts:5–18, 50–73`,
`default-runner.ts:360–380`

The entire `tool` event category is treated as fail-closed, including
`tool.result`. If a category hook throws or rejects after a tool succeeds, the
side effect has happened but no canonical result is stored. Replay invokes the
tool again.

Reproduced: rejecting `tool.result` caused the same write to execute twice
across replay.

Permit veto only for `tool.called`. Terminal result persistence must be
non-vetoable.

### 17. Multiple `awaitInput()` points shift answers on replay

**Priority:** Medium
**File:** `run-context.ts:454–552`

Input consumption is tracked in an in-memory `Set`, while replay starts by
selecting the latest resolved request. A reconstructed context does not know
which await point it is replaying.

Reproduced: with two inputs, after resolving `"first"` and `"second"`, a fresh
replay returned `"second"` from the first `awaitInput()` call and created a
spurious third request.

Assign a deterministic durable ordinal to each await point and resolve that
exact ID during replay.

### 18. Context compaction is lossy, unmetered, and repeatedly recomputed

**Priority:** High
**Files:** `context-manager-impl.ts:79–169, 180–208`,
`run-context.ts:300–314`

The summarizer serializes only `text` blocks. Historical `tool_use` names/args
and `tool_result` content become blank transcript entries despite
`dropSupersededToolOutputs` preparing those results for bounded inclusion.

Compaction calls the model outside normal `llm.call` accounting and does not
persist a checkpoint. Every later over-threshold iteration reloads full history
and pays to summarize again, potentially with the agent's expensive primary
model.

Serialize bounded representations of every content-block type, persist
compaction checkpoints, and account summarizer usage through the normal
model-call path.

---

## Provider & Accounting Findings

### 19. Missing API-key overrides fall back to global credentials

**Priority:** High
**Files:** `clients/index.ts:25–37`,
`clients/openai-client.ts:23–28`,
`clients/anthropic-client.ts:13–19`

When an explicitly configured `apiKeyEnv` is absent, `readEnv()` returns
`undefined`. `OpenAIClient` then reads `OPENAI_API_KEY`; Anthropic similarly
falls back to `ANTHROPIC_API_KEY`. An agent intended to use a tenant-specific
key can silently run and bill against the platform-wide credential.

Distinguish "no override requested" from "explicit override missing." The
latter must fail.

### 20. Missing or malformed OpenAI response fields fail open

**Priority:** High
**File:** `clients/openai-client.ts:40–67, 76–116, 151–159`

Absent usage is normalized to zero. This is common among nominally compatible
endpoints that ignore `stream_options.include_usage`, and it bypasses token and
cost budgets.

Malformed tool arguments are converted to `{ _raw: ... }`; a permissive
`{ type: "object" }` tool schema accepts that object and invokes the tool.
Refusal fields are discarded.

Represent missing usage as unknown and fail closed for budgeted runs. Convert
malformed tool arguments into an error tool result and preserve refusal info.

### 21. Provider retries multiply unexpectedly

**Priority:** Medium
**Files:** `clients/index.ts:15–21`, `clients/retry.ts:22–78, 108–132`

Both installed SDK clients retain their default retry loops, then `withRetry`
adds an outer loop. One logical model call can issue up to twelve HTTP attempts.
The outer `Retry-After` parser treats headers as a plain object, while SDK
errors typically expose a Web `Headers` instance.

Choose one retry owner. If the engine wrapper remains, construct SDK clients
with retries disabled and bound all attempts by the run deadline.

### 22. Cache-token accounting is incomplete

**Priority:** Medium
**Files:** `default-runner.ts:124–131, 439–444`,
`clients/anthropic-client.ts:80–90`,
`clients/openai-client.ts:59–62`

`addUsage` computes cache fields, but the runner copies only `inputTokens` and
`outputTokens` back into returned usage. Token limits also omit Anthropic cache
read/write categories. OpenAI cached-token details are not normalized, so cost
is charged as ordinary input.

Define canonical usage semantics, retain the complete merged `TokenUsage`, and
include all processed-token categories in budget and pricing calculations.

### 23. Model capabilities are inferred from name prefixes

**Priority:** Medium
**Files:** `tiers.ts:21–25`,
`clients/openai-client.ts:121–145`,
`clients/anthropic-client.ts:137–149`

Prefix routing cannot describe parameter, schema, or content-block capabilities:

- `o1`/`o3` reasoning models are routed to OpenAI, but `maxOutputTokens` is
  emitted as incompatible `max_tokens`;
- arbitrary OpenAI-compatible endpoints receive strict `json_schema` even when
  they support only `json_object` or prompt steering;
- unsupported Anthropic content blocks are converted to placeholder text rather
  than round-tripped, breaking signed thinking/tool continuations.

Introduce a provider/model capability registry and reject unsupported
combinations at load time.

---

## Security & Resource Findings

### 24. Cross-origin redirects retain credentials and request bodies

**Priority:** High
**File:** `ssrf-fetch.ts:151–200`

Manual redirect handling reuses the original headers, method, and body for every
3xx response. A trusted API with an open redirect can send `Authorization`,
cookies, custom API keys, or a POST body to an attacker-controlled public host.

Reproduced: both `Authorization` and `X-API-Key` remained present after a
redirect between two public IP origins.

Implement Fetch method/body semantics and strip credential-bearing headers
whenever origin changes.

### 25. HTTP deadlines end when headers arrive

**Priority:** High
**Files:** `ssrf-fetch.ts:162–190, 210–243`,
`mcp-client.ts:247–264, 277–312`

Both transports clear their timer once `fetch()` returns response headers.
Subsequent streamed body reads have no total or idle deadline. MCP's SSE parser
waits for EOF even though a valid SSE connection can remain open after emitting
the matching response.

Keep a combined total/idle deadline through body consumption, parse SSE
incrementally until the matching response arrives, and bound teardown.

### 26. MCP stdio lifecycle and isolation are incomplete

**Priority:** High
**File:** `mcp-client.ts:10–28, 112–207`

- stdout accumulates without a frame-size cap until a newline appears;
- failed initialization rejects before any owner can close the child;
- `close()` sends SIGTERM but neither awaits exit nor escalates;
- the process shares the host user, filesystem, and network.

Bound protocol frames, close on every initialization failure, await exit with
SIGKILL fallback, propagate cancellation, and run untrusted stdio MCP servers
under an isolated user/sandbox.

### 27. Tool inputs and outputs are persisted without redaction

**Priority:** High
**Files:** `default-runner.ts:56–59, 137–143, 353–380`,
`run-context.ts:212–227, 256–276, 417–419`

Raw user input, tool arguments, approval payloads, errors, and results flow into
the event store and external tracer. Tokens, passwords, signed URLs, or
sensitive API responses can remain in durable history and observability exports.

Add centralized schema-aware redaction before persistence and tracing.

### 28. Sandbox output limits apply after unbounded buffering

**Priority:** High
**Files:** `sandbox.ts:70–79`,
`sandbox-tool-source.ts:69–72, 94–123, 221–229`

`collectExecOutput` stores every chunk and joins the complete string before
`truncate()` runs. A model-controlled `yes` loop, large file, or huge directory
can exhaust the worker heap before the nominal 50,000-character cap applies.

Enforce byte and time limits while consuming events and cancel execution when
the cap is reached.

### 29. Concurrent `apply_patch` calls share a temporary filename

**Priority:** Medium
**File:** `sandbox-tool-source.ts:185–199`

Every call writes `/tmp/.render-agent.patch`, and cleanup runs only after a
successful `git apply`. Concurrent calls in one sandbox can overwrite, apply,
or remove one another's patch; failures leave potentially sensitive diffs.

Use a tool-call-specific random path and remove it unconditionally in a
`finally` block.

### 30. Subagent fanout enforcement has a TOCTOU race

**Priority:** High
**File:** `subagent-source.ts:63–89`

Fanout count checking and dispatch/increment are separate operations. Parallel
subagent tools can all read the same old value and exceed `maxFanout`; the SDK's
execution-local counter also resets on replay.

Reproduced: with `maxFanout: 1`, two parallel calls both dispatched.

Atomically reserve fanout in durable run state before dispatch and reconstruct
reservations from `subagent.spawned` events.

### 31. Streaming and tool-environment lifecycle is not replay-safe

**Priority:** Medium
**Files:** `run-context.ts:130–134, 230–243`,
`tool-impl.ts:112–194`

A slow `DeltaBus` creates an unbounded promise chain; completion does not await
the publish tail, and delta sequence numbers restart when a context is rebuilt
after pause. Separately, a `ToolEnvironment` reused after `dispose()` never
closes newly mounted sources because its `disposed` flag remains true.

Selective tool IDs also use `split("__")[1]`, so a valid tool name containing a
second `__` cannot be mounted.

Add bounded delta backpressure and a replay epoch, flush before terminal events,
make `ToolEnvironment` explicitly single-use, and split names only at the first
separator.

### 32. Sandbox IDs are ambient capabilities

**Priority:** Medium
**File:** `sandbox-tool-source.ts:24–31, 94–99`

Every model-supplied `sandbox_id` is passed directly to
`provider.connect(sandboxId)` without run/user ownership validation. Security
depends entirely on IDs remaining secret and on provider-side checks not
represented in the interface.

Bind allowed sandbox IDs to a run/user or replace raw IDs with scoped,
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
