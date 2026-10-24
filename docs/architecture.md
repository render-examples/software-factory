# Architecture

Software Factory separates model-directed work from authority. Agents inspect
and modify code inside short-lived Render Sandboxes; trusted Workflows code
decides what may be written to GitHub.

## System

```mermaid
flowchart LR
  GitHub -->|signed webhook| Gateway
  Gateway -->|start task| Workflows
  Gateway -.->|delivery telemetry| Postgres
  Workflows -.->|run telemetry| Postgres
  Workflows -->|restore and execute| Sandbox
  Sandbox -->|proposed result| Workflows
  Workflows -->|validated writes| GitHub
  Workflows -->|build| Snapshot
  Snapshot -.->|restore| Sandbox
```

The Blueprint creates three persistent resources:

- **Gateway** verifies GitHub webhooks and maps each delivery to one task.
- **Workflows** runs the claiming tasks, agents, cancellation, snapshot refresh, and
  GitHub publishing.
- **Postgres** stores best-effort telemetry. It's optional: without
  `DATABASE_URL`, events are dropped and nothing else changes.

Each claiming task receives a fresh Sandbox restored from a repository snapshot.
Render Workflows owns task state and timeouts. GitHub owns the human
conversation and artifacts. The application has no custom queue, dispatcher,
heartbeat loop, or maintenance cron.

## Human-gated flow

```text
issue --factory:triage--> specification
specification --factory:spec-approved--> verified draft PR
pull request --factory:pr-review--> COMMENT review
```

The tasks never chain automatically. The factory cannot approve, request
changes, mark ready, or merge.

### Triage

Triage reads the issue discussion and base branch, then asks up to five
questions, writes a bounded specification, or declines. Questions and specs
are GitHub comments with hidden structured markers.

### Spec-to-PR

Spec-to-PR verifies that the specification has not changed since approval,
implements it in a Sandbox, runs configured checks, permits bounded repair
attempts, and opens a draft pull request on
`factory/issue-<number>`.

### PR Reviewer

PR Reviewer checks out the labeled head commit, runs configured verification,
and posts one COMMENT review covering security, correctness, performance, and
tests.

## State ownership

| State | Owner |
|---|---|
| Task status, timing, input, and result | Render Workflows |
| Issues, labels, specifications, PRs, and reviews | GitHub |
| Current run for an issue or PR, and its Sandbox | App-authored status comment marker |
| User-visible run status | The same status comment, and the working label |
| Prepared repository filesystem | Render Sandbox snapshot |
| Delivery, run, agent, and cost history | Postgres events (optional) |

Nothing reads Postgres back to decide what a task does.

## Idempotency and competing runs

The system handles retries and overlap at three levels:

1. GitHub's delivery ID is the Workflows idempotency key.
2. The status comment is the claim: a claiming task works only while the
   comment names its run.
3. App-authored markers let writes update or reuse existing artifacts.

A new trigger takes over by cancelling the run the status comment names,
terminating that run's Sandbox, and rewriting the comment to name itself.
Render kills a cancelled task run's process within about a second, so a
replaced run can't keep writing. Two triggers that arrive together both take
over; the run whose status write lands last keeps the claim, and the other
stops at its next checkpoint. Every claiming task checks the claim before
progress updates and durable writes. Publishing also uses a deterministic
branch and refuses to overwrite human commits.

## Sandbox lifecycle

A base-branch push builds a repository snapshot containing runtime tools, a
base checkout, and installed dependencies. Every claiming task:

1. restores the newest snapshot;
2. verifies its permissions and process hardening;
3. fetches the exact requested ref with a temporary read-only token;
4. removes and verifies removal of that token;
5. reinstalls dependencies if lockfiles or the install command changed;
6. runs agents and repository commands as an unprivileged user; and
7. closes the Sandbox in `finally`.

A cancelled task run is killed without reaching `finally`, so each claiming
task records its Sandbox in the status comment, and the run or `/factory cancel`
that stops it terminates the Sandbox. The provider-side timeout is the backstop
for anything else that dies before cleanup.

## Agent contract

An agent definition fixes its prompt, model tier, tools, output schema, turn
limit, and optional thinking level. The complete model loop and every
model-directed tool run inside the Sandbox.

Agents finish through a typed `submit` tool. The Sandbox validates the
submission against JSON Schema, and the host validates it again with the
authoritative Zod schema. Repositories, refs, issue numbers, pull requests,
and write destinations come from authenticated task input—not model output.

## Publishing boundary

The Sandbox has no GitHub write credential. It produces a candidate tree,
which trusted Workflows code validates before publishing:

1. collect changes through a throwaway Git directory;
2. validate paths, modes, file counts, sizes, and blob hashes;
3. reject workflow files, symlinks, and submodules;
4. ask GitHub to build the same tree independently;
5. require GitHub's tree SHA to match the Sandbox tree SHA; and
6. move the deterministic branch only when ownership is safe.

This makes the model a source of proposed bytes, not authority over GitHub.

## Trust boundaries

The factory treats issue text, comments, source files, dependency scripts,
and pull request diffs as untrusted.

### Gateway

The gateway verifies the webhook signature before parsing JSON. It holds no
GitHub credential and runs no model or repository code.

### Workflows host

The Workflows service holds service credentials. Trusted code selects
destinations, enforces run ownership, validates Sandbox output, and performs
GitHub writes. No agent tool runs in this process.

### Sandboxes

Clone and fetch use temporary read-only credentials that are removed before
repository code or agents run. Runtime files are root-owned and read-only.
Agents and repository commands run unprivileged.

The model key enters the Sandbox for an agent call. It is delivered through a
root-only path and stdin, removed from the environment before tools run, and
protected by a non-dumpable runner. These controls reduce exposure but do not
eliminate it.

## Security invariants

Changes must preserve these properties:

1. Verify webhook signatures before parsing.
2. Check the triggering actor's live permission for every run.
3. Keep GitHub write credentials out of Sandboxes.
4. Run all model-directed tools inside Sandboxes.
5. Reconstruct repositories, refs, branches, and write targets from trusted input.
6. Publish only after GitHub reproduces the validated tree SHA.
7. End automation at a draft PR and COMMENT review.
8. Implement the exact specification that was approved.
9. Put a timeout and `finally` cleanup around every Sandbox.
10. Keep Postgres telemetry-only: no task behavior may depend on it.

Tests pin these invariants and each built-in agent's tool authority.

## Residual risks

- Sandboxes use allow-all egress, leaving network and DNS exfiltration paths.
- The model key exists in runner memory during a call.
- Any collaborator with `minimumPermission` can initiate model spend.
- PR Reviewer executes configured verification against the labeled PR code.
- Prompt injection can influence specs, code, and reviews.
- The Render API key may have workspace-wide authority.
- The claim relies on reading the status comment back right after writing it.
  Two triggers within a second of each other can both do work before one stops.
- Workflows inputs and results are visible to users with access to the service.

Use a dedicated Render workspace and spend-capped model key when stronger
isolation is required.

## Code map

Start with these files:

1. [`app/gateway/routes.ts`](../app/gateway/routes.ts) — event routing.
2. [`app/claims/claim.ts`](../app/claims/claim.ts) — the claim lifecycle every claiming task shares.
3. [`app/workflows/triage/index.ts`](../app/workflows/triage/index.ts) — one complete claiming task.
4. [`app/agents/run.ts`](../app/agents/run.ts) — Sandbox agent execution.
5. [`app/sandbox/sandbox.ts`](../app/sandbox/sandbox.ts) — Sandbox lifecycle.
6. [`app/workflows/spec-to-pr/index.ts`](../app/workflows/spec-to-pr/index.ts) — implementation and verification.
7. [`app/changeset/index.ts`](../app/changeset/index.ts) — validated publishing.

See [Contributing](../CONTRIBUTING.md) for local development and extension
recipes.
