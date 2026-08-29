# Eval Suite — MVP Spec

Measure whether the factory produces correct outcomes, and catch regressions
in quality, cost, and speed when agents or workflows change.

---

## What we're evaluating

Two levels, bottom-up:

1. **Agent evals** — does a single agent (judge, triage, planner, researcher)
   produce the right structured output for a known input?
2. **Workflow evals** — does an end-to-end workflow (pr-review, spec-to-pr,
   pr-fix) reach the right outcome given a realistic scenario?

Agent evals are fast and cheap (mock model, milliseconds). Workflow evals are
slower (multiple agents, sandbox setup) but test the real orchestration.

---

## Architecture

```
app/evals/
├── scenarios/
│   ├── agents/
│   │   ├── judge-approve.json
│   │   ├── judge-reject.json
│   │   ├── triage-underspecified.json
│   │   └── planner-multi-file.json
│   └── workflows/
│       ├── pr-review-approve.json
│       ├── pr-review-reject.json
│       ├── spec-to-pr-happy.json
│       └── pr-fix-no-changes.json
├── runner.ts          ← scenario loader + test harness
├── scoring.ts         ← assertion helpers
└── eval.test.ts       ← vitest entrypoint
```

Run with `pnpm test:eval`. Standard vitest — no custom CLI, no new infra.

---

## Scenario format

Each scenario is a JSON file describing inputs, model behavior, and expected
outcomes.

### Agent scenario

```json
{
  "type": "agent",
  "agent": "judge",
  "description": "Approve a clean PR with no issues found",
  "input": "All reviews are positive. No bugs, no security issues.",
  "model": {
    "responses": [
      {
        "text": "Based on the reviews, this PR is ready to merge.",
        "data": { "decision": "approve", "reason": "All reviews positive" }
      }
    ]
  },
  "expect": {
    "data": { "decision": "approve" },
    "status": "completed",
    "maxIterations": 3,
    "maxCostUsd": 0.05
  }
}
```

### Workflow scenario

```json
{
  "type": "workflow",
  "workflow": "pr-review",
  "description": "Reject a PR that introduces a SQL injection",
  "input": {
    "repo": "jacobprall/factory-test-repo",
    "pr_number": 1,
    "action": "opened"
  },
  "model": {
    "responses": "auto"
  },
  "expect": {
    "result": { "decision": "request_changes" },
    "status": "completed",
    "steps": {
      "judge": { "decision": "request_changes" }
    },
    "maxCostUsd": 1.00
  }
}
```

**`model.responses`** controls the model:
- Array of objects → `mockModel` replays them in order (deterministic, free)
- `"auto"` → real LLM calls (integration eval, costs money)

---

## Runner

Built on `createTestRuntime` + `mockModel` from `@render-factory/sdk/testing`.

```
loadScenario(path)
  → build runtime (mock or real model)
  → dispatch agent.run() or workflow.dispatch()
  → collect: run record, spans, child runs, cost, step results
  → return EvalResult
```

### `EvalResult`

```ts
interface EvalResult {
  scenario: string;
  passed: boolean;
  failures: string[];       // human-readable assertion failures
  run: {
    id: string;
    status: string;
    result: unknown;
    totalCostUsd: number;
    durationMs: number;
    iterations: number;
    tokenUsage: { input: number; output: number };
  };
  steps: Record<string, unknown>;  // memoized step results
  children: Array<{ agent: string; status: string; costUsd: number }>;
}
```

---

## Scoring

Assertions are simple predicates — no LLM-as-judge in v1.

| Assertion | What it checks |
|-----------|---------------|
| `status` | Run completed/failed/cancelled as expected |
| `result` | Deep-partial match against `expect.result` |
| `data` | Agent structured output matches `expect.data` |
| `steps` | `getStepResult(name)` matches expected value |
| `maxIterations` | Agent loop didn't exceed N iterations |
| `maxCostUsd` | Total cost (including child runs) stayed under budget |
| `maxDurationMs` | Wall-clock time didn't exceed threshold |
| `toolsCalled` | Specific tools were (or weren't) invoked |

**Partial matching:** `expect.result: { "decision": "approve" }` passes if the
actual result contains `{ decision: "approve", ...anything }`. Fields not in
the expectation are ignored.

---

## What's already built

The eval suite plugs into existing infrastructure — no new packages needed.

| Existing piece | Used for |
|---------------|----------|
| `createTestRuntime()` | In-memory store, real runner, in-process dispatch |
| `mockModel(handler)` | Deterministic model responses for agent evals |
| `store.getRun(id)` | Run outcome, cost, status |
| `store.listSpans(runId)` | Iterations, token usage, latency per agent |
| `store.getStepResult(runId, name)` | Intermediate workflow results |
| `store.listChildRuns(runId)` | Fan-out cost and outcome per specialist |
| `aggregateRunCost(store, runId)` | Total cost including delegation |
| Agent `output` schemas | Typed `.data` on judge, triage, planner |
| `EventInterceptor` | Optional: live assertions during a run |

---

## What's NOT in v1

| Deferred | Why |
|----------|-----|
| LLM-as-judge scoring | Adds cost, complexity, and its own eval problem |
| GitHub integration tests | Need sandbox GitHub or heavy mocking; test the workflow logic instead |
| Eval dashboard / UI | vitest output + snapshots are enough to start |
| Automated regression detection | Compare snapshots manually; automate when we have enough history |
| Dataset generation | Hand-write scenarios first; generate from production runs later |
| Chat-turn quality evals | chat-turn output lives in messages, not `result` — needs a different assertion shape |

---

## Rollout

### Phase 1: Agent evals (days)

Write 3–5 scenarios per structured-output agent (judge, triage, planner).
Mock model, deterministic, runs in CI. Validates that prompt + schema changes
don't break the output contract.

### Phase 2: Workflow evals (week)

Write 2–3 scenarios per workflow (pr-review, spec-to-pr, pr-fix). Mock model
for CI. Validates orchestration logic — fan-out, step ordering, result
assembly, skip conditions.

### Phase 3: Integration evals (periodic)

Same scenarios with `"model": { "responses": "auto" }` — real LLM calls.
Run on a schedule (not every CI push). Catches model-tier regressions and
prompt drift. Cost-capped per run.

---

## Success criteria

The eval suite is useful when:

1. A dev can add a scenario by dropping a JSON file — no code changes
2. `pnpm test:eval` catches a real regression before it ships
3. Cost/token snapshots flag when a prompt change doubles spend
4. The suite runs in < 30s for mock scenarios (CI-viable)
