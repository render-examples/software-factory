# Takeaways

This project is an example of a broader pattern: let people approve each step
in the tool they already use, run each agent job in a fresh Render Sandbox,
and keep authority and acceptance outside that Sandbox. These are the parts
worth reusing.

## Let the platform and GitHub hold the state

The gateway verifies an event and starts one named Workflows task. Render owns
task state, timing, idempotent starts, cancellation, logs, timeouts, and
operator visibility. GitHub owns the conversation and its artifacts: issues,
comments, labels, commits, PRs, and reviews. The factory has no queue,
dispatcher, worker heartbeat, retry scheduler, Sandbox reaper, maintenance
cron, or database copy of GitHub.

Hidden markers make ordinary GitHub artifacts machine-readable. A status
comment identifies the current task, a questions marker the Triage round, a
spec marker the bounded spec with its version and content hash, and a review
marker the reviewed commit. The visible comment stays useful to a person, and
a later task recovers exact structured state from the marker. Trust a marker
only when the host proves your App or bot wrote it.

Every system you don't build is a set of states you don't have to reconcile.
Use this pattern when an event maps cleanly to a durable unit of work, and
add a second source of truth only when the domain needs queries or
transactions the host can't provide.

Implementation:
[`app/gateway/routes.ts`](../app/gateway/routes.ts),
[`app/workflows/index.ts`](../app/workflows/index.ts),
[`app/github/markers.ts`](../app/github/markers.ts), and
[`app/runs/status.ts`](../app/runs/status.ts).

## Make human gates explicit transitions

Triage doesn't start implementation, and implementation doesn't start review.
Each transition is a visible GitHub label applied by a permitted person:

```text
issue --factory:triage--> spec
spec --factory:spec-approved--> draft PR
PR --factory:pr-review--> COMMENT review
```

That creates clear authorization and review points. The request is clarified
before any code is generated, the exact spec is approved before
implementation, the generated change stays a draft, and review reports risk
without exercising merge authority. Using the collaboration tool's native
actions means people can see and audit the gates without learning a separate
control plane.

Implementation:
[`app/gateway/routes.ts`](../app/gateway/routes.ts),
[`app/workflows/spec-to-pr/approval.ts`](../app/workflows/spec-to-pr/approval.ts),
and [`app/runs/permission.ts`](../app/runs/permission.ts).

## Make repeated and competing runs safe

Starting a newer run doesn't instantly stop an older one. Cancellation is
cooperative, webhooks are redelivered, and a task may be between a model call
and a write. The factory handles this at three layers:

1. **Ownership:** each stage appends `run.claimed` after checking permission.
   Postgres's monotonic event ID is the fencing token, and the greatest claim
   for an issue or PR is current. Runs recheck it before agent work, progress
   updates, and durable writes, so a late run can't publish after losing
   ownership. There is no mutable lock row to recover.
2. **Execution:** the GitHub delivery ID is the Workflows idempotency key,
   which suppresses immediate duplicate starts. That window is finite and
   scoped to a deployed workflow version, so it can't be the only defense.
3. **Effects:** before creating a comment, spec, PR, or review, trusted code
   looks for its App-authored marker and updates or reuses the artifact.
   Publishing uses a deterministic branch and refuses to overwrite human
   commits.

Claims are part of correctness and fail closed: if Postgres can't append or
read one, the stage stops rather than risk two writers. Delivery, run, and
agent events share the same table but are telemetry, fail open, and are never
read back by a stage. When one store holds both control and telemetry, make
the difference visible in its API so a dashboard query can't quietly become
workflow state.

Implementation:
[`app/events/index.ts`](../app/events/index.ts),
[`app/runs/with-run.ts`](../app/runs/with-run.ts),
[`app/gateway/index.ts`](../app/gateway/index.ts), and
[`app/changeset/index.ts`](../app/changeset/index.ts).

## Prepare Sandboxes once, and verify them every time

Each repository snapshot holds tools, the bundled runner, a base checkout,
and installed dependencies, so a stage restores it instead of repeating
setup. The current ref is still fetched for every run. A manifest records the
base commit, lockfile hash, and install command, and the Sandbox reinstalls
dependencies when they differ. A stale snapshot can still run the current
ref, base-branch pushes refresh it in the background, and the first run builds
it inline. Stable names decouple the builder from readers, and keeping two
versions covers a restore that overlaps a replacement.

The builder needs network access and, briefly, a repository credential, so it
orders its work by trust. It installs tools and self-tests the runner, stages
a read-only token, clones the exact commit, then scrubs the token and checks
that it's gone. Only after that does the repository's install run,
unprivileged, before the filesystem is locked down and snapshotted. Each
stage fetch follows the same rule and scrubs the token even when the fetch
fails. Credentials are files read by a helper, never command arguments, clone
URLs, inherited environment variables, or persistent Git config.

Don't assume a sequence of API calls produced the intended boundary.
`verify.sh` checks the real layout, ownership, permissions, credential
absence, and process hardening before a snapshot is created and after every
restore. The host also refuses to send a model key until it confirms the
runner is non-dumpable.

Implementation:
[`app/sandbox/snapshot.ts`](../app/sandbox/snapshot.ts),
[`app/sandbox/sandbox.ts`](../app/sandbox/sandbox.ts),
[`sandbox/build/scrub-credentials.sh`](../sandbox/build/scrub-credentials.sh),
and [`sandbox/verify.sh`](../sandbox/verify.sh).

## Put the agent in the Sandbox, and name the real boundaries

The whole agent loop, model calls and tools alike, runs in the Sandbox beside
the checkout. The Workflows task uploads one input file, runs the bundled
runner, and downloads its events. The alternative, a loop in the task that
proxies each tool call through the Sandbox API, would keep the model key out
of the Sandbox. It would also turn every tool call into a request under a
workspace-wide rate limit, which slows long implementation runs and starves
concurrent stages. The cost of this placement is hardening around the key
instead: root-only delivery over stdin, removal from the environment before
tools run, and a non-dumpable runner.

Keep placement mechanical. `runAgent` requires a Sandbox, so tools never run
in the process that holds service credentials. Each independently authorized
stage gets a fresh Sandbox, reused for related work on the same checkout
(Spec-to-PR's implementer, verification, and repairs) but never across
issues, PRs, or approvals. `withSandbox` closes it however the stage ends,
and the provider-side timeout covers a process that dies first.

Then say which layer enforces each property. The read-only shell policy
rejects obvious mutation and network commands, which steers the model and
saves turns, but it's an approximate filter, not a boundary. The boundaries
are tool placement, the unprivileged Sandbox user, no write credential in the
Sandbox, destinations from trusted task input, bounded Sandbox lifetime, and
host-side acceptance. Naming them keeps a convenient guardrail from quietly
becoming the only defense.

Implementation:
[`app/agents/run.ts`](../app/agents/run.ts),
[`tests/agents-catalog.test.ts`](../tests/agents-catalog.test.ts),
[`app/runner/shell-policy.ts`](../app/runner/shell-policy.ts), and
[`sandbox/as-runner.sh`](../sandbox/as-runner.sh).

## Let agents propose; let trusted code decide

Every agent submits through one `submit` tool built from its Zod schema. The
runner lets the model repair an invalid submission, and the host validates
the result again. The rest of the system consumes bounded domain values (a
triage decision, spec sections, an implementation summary, a review), not
parsed prose. Lengths and array sizes are bounded because the values reach
GitHub, and targets, identities, links, and permissions are rebuilt from
trusted state rather than taken from the model.

The same rule governs code changes. The Sandbox can propose bytes but holds
no GitHub write token. Collection stages the candidate tree in a throwaway
Git directory so agent-written hooks, config, or replacement refs can't shape
it. The host validates paths, modes, counts, sizes, and blob hashes, has
GitHub build the tree independently, requires the two tree SHAs to match,
checks branch ownership, and only then moves a ref and opens a draft PR.

Generalize this as proposal versus authority: let the agent produce a
candidate, check it against independent ground truth, reconstruct
destinations outside the agent, and give the smallest host component the
authority to commit it.

Implementation:
[`app/schemas/`](../app/schemas),
[`app/runner/submit.ts`](../app/runner/submit.ts),
[`sandbox/collect-changes.sh`](../sandbox/collect-changes.sh), and
[`app/changeset/index.ts`](../app/changeset/index.ts).

## Bound every run, and decide once which failures are expected

Providers report cost after a response, so an in-process dollar threshold is
always soft: the response that crosses it is already charged. Instead, each
agent has a turn limit and a call timeout, each stage has a fixed number of
repair rounds, no stage retries automatically, and the model key carries a
provider-enforced spend limit. Usage and cost are still recorded on every
`agent.finished` event, whether the call succeeded or not.

When a run does stop, the cause decides how it's reported. Some failures
belong to the work: a person lacks permission, the spec changed after
approval, verification still fails after repairs, or the model ran out of
turns. Those end the run with a clear message on GitHub. Others belong to the
platform, such as a lost Sandbox, an unreachable API, or a runner that died
without a result. Those fail the Workflows task so an operator sees them.
`withRun` makes that call for every stage: stage code throws `RunError` for
its own expected outcomes, and an agent that stops on its own counts as
expected. When each stage decides separately, the same error gets reported
three different ways.

Implementation:
[`app/runs/with-run.ts`](../app/runs/with-run.ts),
[`app/agents/run.ts`](../app/agents/run.ts), and
[`app/runner/session.ts`](../app/runner/session.ts).

## Name what you accept

Layered controls reduce authority; they don't make arbitrary code and model
execution perfectly safe. Write down the risks the design accepts, such as a
model key in memory during a call or labeled fork code running in
verification, so an operator can decide whether they fit. This project lists
its own in the architecture guide's
[residual risks](2_ARCHITECTURE.md#residual-risks).
