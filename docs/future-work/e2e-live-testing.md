# E2E Live Testing Workflow

## Motivation

The `spec-to-pr` workflow currently runs unit/integration tests inside the sandbox before pushing. But these tests run against mocked or local environments — they never exercise the application as a deployed service handling real HTTP requests.

A live testing workflow would:
1. Deploy the PR branch to a **preview environment** on Render
2. Run an agent-driven test suite against the live preview URL
3. Report pass/fail results back to the PR (and the originating thread)
4. Tear down the preview when done

This catches deployment-specific failures that sandbox tests miss: port binding, environment variable wiring, database migrations, TLS, cold-start latency, CORS, multi-service networking.

---

## Workflow: `e2e-live-test`

| Field | Value |
|-------|-------|
| **Trigger** | `spec-to-pr` completion (automatic), GitHub PR label (`agent:test-live`), or manual via `start_workflow` tool |
| **Input** | `{ repo, branch, prNumber, previewUrl? }` |
| **Output** | `{ status, results, previewUrl, teardownAt }` |
| **Agents** | `test-planner`, `test-executor`, `test-reporter` |
| **Services** | Render Preview Environment, Render Sandbox (for test runner), Postgres (results) |

---

## Architecture

```
PR opened / spec-to-pr completes
              │
              ▼
┌──────────────────────────────────┐
│      e2e-live-test workflow       │
├──────────────────────────────────┤
│                                  │
│  1. Provision Preview            │
│     (Render API → deploy branch) │
│                                  │
│  2. Wait for Healthy             │
│     (poll health check endpoint) │
│                                  │
│  3. Plan Tests                   │
│     (test-planner agent)         │
│                                  │
│  4. Execute Tests                │
│     (test-executor in sandbox)   │
│                                  │
│  5. Report Results               │
│     (test-reporter → GitHub PR)  │
│                                  │
│  6. Teardown Preview             │
│     (Render API → delete)        │
│                                  │
└──────────────────────────────────┘
```

---

## Workflow Steps

### Step 1: Provision Preview Environment

Use the Render API to deploy the PR branch as a preview service:

```typescript
const preview = await ctx.step("provision-preview", async () => {
  const service = await renderApi.createPreviewDeploy({
    serviceId: baseServiceId,
    branch,
    commitId: headSha,
  });
  return { serviceId: service.id, deployId: service.deploy.id };
});
```

Alternatively, if the project uses Render Blueprints with preview environments enabled, the preview is created automatically on PR open. The workflow detects and attaches to it:

```typescript
const preview = await ctx.step("find-or-create-preview", async () => {
  const existing = await renderApi.listPreviews(serviceId, { branch });
  if (existing.length > 0) return existing[0];
  return renderApi.createPreviewDeploy({ serviceId, branch, commitId: headSha });
});
```

### Step 2: Wait for Healthy

Poll the preview's health check endpoint until it responds 200 or a timeout expires:

```typescript
const live = await ctx.step("wait-healthy", async () => {
  const url = preview.url;  // e.g. https://my-app-pr-42.onrender.com
  const healthPath = config.healthCheckPath ?? "/health";

  const deadline = Date.now() + (config.deployTimeoutMs ?? 300_000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}${healthPath}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return { url, healthy: true, waitMs: Date.now() - start };
    } catch {}
    await sleep(5000);
  }
  throw new Error(`Preview did not become healthy within ${config.deployTimeoutMs ?? 300_000}ms`);
});
```

### Step 3: Plan Tests (Agent)

The `test-planner` agent analyzes the PR diff and the application to generate a test plan:

```typescript
const plan = await ctx.agents.get("test-planner").run<TestPlan>(`
  Preview URL: ${live.url}
  Repository: ${repo.owner}/${repo.repo}
  Branch: ${branch}
  PR: #${prNumber}

  Diff summary:
  ${diffSummary}

  Generate a test plan that covers:
  1. Smoke tests (service is up, key endpoints respond)
  2. Regression tests (existing functionality still works)
  3. Feature tests (new behavior introduced by this PR)
  4. Edge cases (error handling, invalid inputs, auth boundaries)
`);
```

**`test-planner` agent definition:**

```yaml
---
description: Plans E2E test scenarios against a live preview deployment
tools: [sandbox]
budget:
  maxIterations: 20
  maxCostUsd: 3
output:
  type: object
  properties:
    scenarios:
      type: array
      items:
        type: object
        properties:
          name: { type: string }
          method: { type: string, enum: [GET, POST, PUT, PATCH, DELETE] }
          path: { type: string }
          headers: { type: object }
          body: { type: object }
          assertions:
            type: array
            items:
              type: object
              properties:
                field: { type: string }
                operator: { type: string, enum: [eq, contains, matches, status, headerPresent, latencyBelow] }
                expected: {}
        required: [name, method, path, assertions]
  required: [scenarios]
---
```

### Step 4: Execute Tests (Agent + Sandbox)

The `test-executor` agent runs the planned scenarios against the live URL from a sandbox. Using a sandbox ensures network isolation from internal services and provides a clean execution environment:

```typescript
const results = await ctx.agents.get("test-executor").run<TestResults>(`
  Preview URL: ${live.url}
  Test plan:
  ${JSON.stringify(plan.data.scenarios, null, 2)}

  Execute each test scenario against the live preview URL.
  For each scenario:
  - Make the HTTP request
  - Evaluate all assertions
  - Record pass/fail with actual vs expected values
  - Measure response latency
  - If a test fails, attempt a brief diagnosis (check response body, status, headers)

  Report results for ALL scenarios even if some fail.
`);
```

The executor uses the `sandbox` tool to run `curl` or a test script, giving it full control over request construction and the ability to handle complex flows (multi-step auth, WebSocket connections, file uploads):

```typescript
// Inside the sandbox, the agent might generate and run:
const script = `
import http from 'node:http';

const scenarios = ${JSON.stringify(plan.scenarios)};
const baseUrl = '${live.url}';

for (const scenario of scenarios) {
  const url = new URL(scenario.path, baseUrl);
  const start = Date.now();
  const res = await fetch(url, {
    method: scenario.method,
    headers: scenario.headers,
    body: scenario.body ? JSON.stringify(scenario.body) : undefined,
  });
  const latencyMs = Date.now() - start;
  const body = await res.text();
  // ... evaluate assertions, emit results
}
`;
```

### Step 5: Report Results

The `test-reporter` agent formats results and posts them to the PR:

```typescript
const report = await ctx.agents.get("test-reporter").run(`
  Test results:
  ${JSON.stringify(results.data, null, 2)}

  Format a GitHub PR comment with:
  - Summary line (X passed, Y failed, Z skipped)
  - Table of all scenarios with status
  - Details for failures (expected vs actual)
  - Performance notes (any endpoints > 500ms)
  - Recommendation (merge/fix/investigate)
`);

await ctx.step("post-results", async () => {
  await gh.createPrComment(repo, prNumber, report.text);

  // Set commit status
  const allPassed = results.data.scenarios.every(s => s.status === "passed");
  await gh.createCommitStatus(repo, headSha, {
    state: allPassed ? "success" : "failure",
    context: "render-factory/e2e-live-test",
    description: allPassed
      ? `${results.data.scenarios.length} scenarios passed`
      : `${results.data.scenarios.filter(s => s.status === "failed").length} failures`,
    targetUrl: `${dashboardUrl}/runs/${ctx.runId}`,
  });
});
```

### Step 6: Teardown Preview

Clean up the preview environment (unless configured to keep it for manual inspection):

```typescript
await ctx.step("teardown-preview", async () => {
  if (config.keepPreviewOnFailure && !allPassed) {
    return { kept: true, reason: "failures detected, keeping for inspection" };
  }
  await renderApi.deletePreview(preview.serviceId);
  return { tornDown: true };
});
```

---

## New Agents

### `test-planner`

```markdown
---
description: Plans E2E test scenarios against a live preview deployment
tools: [sandbox]
budget:
  maxIterations: 20
  maxCostUsd: 3
---

You are a test planning agent. Given a live preview URL and a PR diff, generate
a comprehensive but focused set of HTTP test scenarios.

Prioritize:
1. Smoke tests confirming the service is up and core routes respond
2. Tests targeting the specific changes in the PR diff
3. Regression tests for functionality adjacent to the changes
4. Edge cases: malformed input, auth failures, rate limits

Each scenario must include concrete assertions (status codes, response body
fields, headers, latency thresholds). Keep the total scenario count between
5–20 to balance coverage and execution time.
```

### `test-executor`

```markdown
---
description: Executes E2E test scenarios against a live URL and reports results
tools: [sandbox]
budget:
  maxIterations: 40
  maxCostUsd: 5
---

You are a test execution agent. Given a preview URL and a list of test
scenarios, execute each one by making real HTTP requests from the sandbox.

For each scenario:
- Construct and send the exact HTTP request specified
- Evaluate every assertion against the actual response
- Record: status (passed/failed/error), latencyMs, actual values, error details
- If a test fails, briefly diagnose (e.g. "returned 404, route may not be registered")

Execute ALL scenarios. Do not stop on first failure. Report structured results.
```

### `test-reporter`

```markdown
---
description: Formats E2E test results into a clear GitHub PR comment
budget:
  maxIterations: 5
  maxCostUsd: 1
---

You are a test reporting agent. Given raw test results, produce a clear,
well-formatted GitHub PR comment.

Format:
- **Summary line**: ✓ X passed, ✗ Y failed, ⊘ Z skipped
- **Results table**: scenario name | method | path | status | latency
- **Failure details**: for each failure, show expected vs actual with diagnosis
- **Performance**: flag any endpoint responding > 500ms
- **Recommendation**: "Safe to merge" / "Fix required" / "Needs investigation"

Be concise. Developers should understand the state in 5 seconds from the summary.
```

---

## Configuration

Project-level configuration in `project.yaml` or agent frontmatter:

```yaml
e2e:
  # Which Render service to deploy previews from
  baseServiceId: srv-abc123
  # Health check endpoint to poll
  healthCheckPath: /health
  # Max time to wait for preview to become healthy (ms)
  deployTimeoutMs: 300000
  # Keep preview alive on failure for manual inspection
  keepPreviewOnFailure: true
  # Max time for entire workflow (ms)
  workflowTimeoutMs: 600000
  # Trigger automatically after spec-to-pr, or only on label
  autoTrigger: true
  # Additional headers for test requests (e.g. auth tokens for preview)
  defaultHeaders:
    Authorization: "Bearer ${PREVIEW_TEST_TOKEN}"
```

---

## Trigger Integration

### Automatic (post spec-to-pr)

At the end of `spec-to-pr`, if `e2e.autoTrigger` is enabled:

```typescript
// At the end of spec-to-pr, after PR is opened:
if (config.e2e?.autoTrigger) {
  await ctx.step("trigger-e2e", async () => {
    await ctx.runtime.dispatch("e2e-live-test", {
      repo, branch, prNumber: pr.number, headSha,
    }, { threadId: run.threadId });
  });
}
```

### Manual (GitHub label)

Add label `agent:test-live` to any PR → GitHub webhook triggers the workflow:

```typescript
// In the GitHub webhook handler
if (event.action === "labeled" && event.label.name === "agent:test-live") {
  await dispatch("e2e-live-test", {
    repo: { owner: event.repository.owner.login, repo: event.repository.name },
    branch: event.pull_request.head.ref,
    prNumber: event.pull_request.number,
    headSha: event.pull_request.head.sha,
  });
}
```

### Chat-initiated

From a Slack conversation with the assistant:

> "Run live tests against the preview for PR #42"

The assistant calls `start_workflow` with the `e2e-live-test` workflow.

---

## Preview Environments on Render

Render supports [preview environments](https://render.com/docs/preview-environments) that automatically deploy PR branches. Two integration modes:

### Mode A: Blueprint Preview Environments (Recommended)

If the project has `previews.enabled: true` in `render.yaml`, Render automatically creates a preview for each PR. The workflow attaches to the existing preview:

```yaml
# render.yaml
previews:
  generation: automatic
  expireAfterDays: 3
```

The workflow skips step 1 (provision) and instead discovers the preview URL from the Render API or the GitHub deployment status.

### Mode B: On-Demand Preview via API

For projects without automatic previews, the workflow creates one via the Render API and tears it down when done. More control, but slower (full build + deploy cycle).

---

## Observability

The workflow emits standard run events visible in the operator UI:

| Event | What it shows |
|-------|---------------|
| `step.started: provision-preview` | Preview deploy initiated |
| `step.completed: wait-healthy` | Preview URL + time to healthy |
| `llm.call` (test-planner) | Test plan generation |
| `tool.called: sandbox__exec` | Each HTTP test request |
| `step.completed: post-results` | Final pass/fail summary |
| `step.completed: teardown-preview` | Cleanup confirmation |

The full test results are available:
- In the GitHub PR comment
- In the run's event log (operator UI)
- In the originating Slack thread (via surface notification)

---

## Error Handling

| Failure Mode | Handling |
|-------------|----------|
| Preview deploy fails | Report build error to PR, skip tests, fail workflow |
| Preview never healthy | Timeout → report "deploy did not start" to PR, teardown |
| Test executor crashes | Retry once, then report partial results |
| All tests pass | Green commit status, "Safe to merge" comment |
| Some tests fail | Red commit status, detailed failure report, keep preview (if configured) |
| Network unreachable from sandbox | Error result, suggest checking preview service networking |

---

## Security Considerations

- Test requests come from a Render Sandbox, not the workflows host — no ambient credentials leak to the preview
- Preview services should NOT have access to production databases; use isolated preview databases (Render Blueprint `previewPlan` handles this)
- Test auth tokens (`PREVIEW_TEST_TOKEN`) are scoped to the preview environment and rotate per deploy
- The test-executor agent can only reach the preview URL and public internet; internal service mesh is not accessible from the sandbox

---

## Effort Estimate

| Piece | Lines | Time |
|-------|-------|------|
| `e2e-live-test` workflow handler | ~200 | 3hr |
| `test-planner` agent definition | ~30 | 15min |
| `test-executor` agent definition | ~30 | 15min |
| `test-reporter` agent definition | ~25 | 15min |
| Render API helpers (preview create/poll/delete) | ~120 | 2hr |
| GitHub label trigger handler | ~40 | 30min |
| Configuration loading + validation | ~60 | 45min |
| Integration with `spec-to-pr` (auto-trigger) | ~20 | 15min |
| Tests (workflow + mocked Render API) | ~250 | 3hr |

**Total: ~775 lines, ~2-3 days.**

---

## Future Extensions

- **Visual regression testing**: screenshot the preview (via headless browser in sandbox), compare against baseline, flag visual diffs
- **Load testing**: run a brief load test (e.g. 50 concurrent requests for 30s) to catch performance regressions before merge
- **Multi-service previews**: for apps with multiple services, deploy the full stack as a preview environment and test inter-service communication
- **Test learning**: after merge, compare production behavior to test predictions; feed discrepancies back to the test-planner to improve future plans
- **Flake detection**: re-run failed tests once; if they pass on retry, mark as flaky rather than failing the PR
