# Takeaways

## Let the workflow platform own execution

The gateway verifies an event and starts one named Workflows task. Render owns
task state, timing, idempotent starts, cancellation, logs, timeouts, and
operator visibility.

The application does not maintain its own:

- queue and dispatcher;
- worker heartbeat and lost-run recovery;
- retry scheduler;
- Sandbox reaper; or
- cron-based maintenance loop.

Removing those systems reduces the number of states the application has to
reconcile. Keep domain behavior in task code and use the platform for task
lifecycle.

Use this pattern when an event maps cleanly to a durable unit of work and the
platform already supplies cancellation, status, and timeouts.

Implementation:
[`app/gateway/index.ts`](../app/gateway/index.ts),
[`app/gateway/routes.ts`](../app/gateway/routes.ts), and
[`app/workflows/index.ts`](../app/workflows/index.ts).

## Make human gates explicit transitions

Triage does not automatically start implementation, and implementation does
not automatically start review. Each transition is a visible GitHub label
applied by a permitted person:

```text
issue --factory:triage--> spec
spec --factory:spec-approved--> draft PR
PR --factory:pr-review--> COMMENT review
```

This is more than a user-interface choice. It creates clear authorization and
review points:

- the request is clarified before code generation;
- the exact spec is approved before implementation;
- the generated change stays draft;
- review reports risk without exercising merge authority.

Use the collaboration system's native actions for gates when possible. People
can see and audit them without learning a separate control plane.

Implementation:
[`app/gateway/routes.ts`](../app/gateway/routes.ts),
[`app/workflows/spec-to-pr/approval.ts`](../app/workflows/spec-to-pr/approval.ts),
and [`app/runs/permission.ts`](../app/runs/permission.ts).

## Keep conversation and artifacts in the system of record

GitHub already stores issues, comments, labels, commits, PRs, and reviews.
The factory does not mirror those into an application database.

Structured hidden markers make ordinary GitHub artifacts machine-readable:

- a status comment identifies the current task;
- a questions marker identifies the Triage round;
- a spec marker carries the bounded spec, version, and content hash;
- a review marker records the reviewed commit.

The visible comment remains useful to a person, while the marker lets a later
task recover exact structured state. Trust a marker only when the hosting
platform proves the artifact came from your App or bot.

Use this pattern for automation that collaborates in an existing system.
Avoid building a second source of truth unless the domain needs queries or
transactions the host cannot provide.

Implementation:
[`app/github/markers.ts`](../app/github/markers.ts),
[`app/runs/status.ts`](../app/runs/status.ts), and
[`app/workflows/triage/spec.ts`](../app/workflows/triage/spec.ts).

## Fence competing runs with append-only claims

Starting a newer run does not instantly stop an older process. Cancellation
is cooperative, webhooks can be redelivered, and a task may be between a
model call and a write.

Each stage therefore appends `run.claimed` after checking permission.
Postgres's monotonic event ID is the fencing token. The greatest claim ID for
one repository and issue or PR is current. Runs recheck ownership before
agent work, progress changes, and durable writes.

This is stronger than "cancel the old task":

- the new claim establishes ownership before cancellation;
- a late old task cannot publish after losing ownership;
- claims are auditable;
- there is no mutable lock row to recover; and
- relabeling naturally starts a new generation.

Make this path strict. If the database cannot append or read the claim, stop
instead of risking two writers. Keep unrelated telemetry best-effort.

Implementation:
[`app/events/index.ts`](../app/events/index.ts) and
[`app/runs/with-run.ts`](../app/runs/with-run.ts).

## Design for idempotency beyond the platform window

The gateway uses each GitHub delivery ID as a Workflows idempotency key, but
platform idempotency has a retention window and can be scoped to a deployed
workflow version. It cannot be the only defense against duplicated writes.

Before creating a comment, spec, PR, or review, trusted code searches for its
App-authored marker and updates or reuses the artifact. Publishing uses a
deterministic branch and refuses to overwrite human commits.

Apply idempotency at two layers:

1. **Execution:** suppress immediate duplicate task starts with an event ID.
2. **Effects:** make every external write discoverable and safe to repeat.

This is useful for any webhook consumer where providers retry and operators
can redeliver old events.

Implementation:
[`app/gateway/index.ts`](../app/gateway/index.ts),
[`app/github/markers.ts`](../app/github/markers.ts), and
[`app/changeset/index.ts`](../app/changeset/index.ts).

## Use snapshots as a prepared base, not stale truth

Each repository snapshot contains tools, a bundled runner, a base checkout,
and installed dependencies. Restoring it avoids repeating expensive setup.

The current ref is still fetched for every run. A manifest records the base
commit, lockfile hash, and install command. If lockfiles or configuration
differ, the restored Sandbox reinstalls dependencies before work starts.

This combines fast starts with correctness:

- a stale snapshot can still run the requested current ref;
- a changed install command takes effect before the next snapshot refresh;
- no task depends on a cron firing on time;
- base-branch pushes refresh preparation in the background; and
- the first run can build the missing snapshot inline.

Stable names decouple writers from readers, and keeping two versions protects
a restore overlapping replacement.

Use this pattern when jobs share a large prepared environment but still need
to bind themselves to a fresh input or commit at execution time.

Implementation:
[`app/sandbox/snapshot.ts`](../app/sandbox/snapshot.ts) and
[`app/sandbox/sandbox.ts`](../app/sandbox/sandbox.ts).

## Order privileged preparation by trust

The snapshot builder needs network access and, briefly, a repository
credential. Sequence its work so third-party code cannot observe that
credential:

1. install tools and self-test the runner;
2. introduce a read-only token;
3. clone the exact commit;
4. scrub and verify removal of the token;
5. run the repository's dependency installation unprivileged;
6. lock down and verify the filesystem;
7. create the snapshot.

The same rule applies to each fetch: stage a read-only token, fetch, scrub it
even on failure, and only then run agents or repository checks.

Credentials should be files read by a helper, not command arguments, clone
URLs, environment variables inherited by arbitrary processes, or persistent
Git configuration.

Implementation:
[`app/sandbox/snapshot.ts`](../app/sandbox/snapshot.ts),
[`sandbox/build/git-credential-staged.sh`](../sandbox/build/git-credential-staged.sh),
and
[`sandbox/build/scrub-credentials.sh`](../sandbox/build/scrub-credentials.sh).

## Put the agent in the Sandbox

The whole agent loop, model calls and tools alike, runs inside the same
Sandbox as the checkout. The Workflows task uploads one input file, runs the
bundled runner, and downloads its events. This gives agents ordinary local
filesystem and process semantics and contains the effects of model-directed
commands.

The alternative, an agent loop in the Workflows task that proxies each tool
call through the Sandbox API, would keep the model key out of the Sandbox. It
would also turn every tool call into an API request under a workspace-level
rate limit, which makes long implementation runs slow and starves concurrent
stages. Running the agent in the Sandbox costs extra hardening around the key
instead: root-only delivery over stdin, credential removal before tools run,
and a non-dumpable runner process.

Keep the placement rule mechanical: `runAgent` requires a Sandbox, so tools
never run in the Workflows process that holds service credentials. Types and
catalog tests enforce that rule. Security should not depend on every call
site remembering it.

Implementation:
[`app/agents/define.ts`](../app/agents/define.ts),
[`app/agents/run.ts`](../app/agents/run.ts), and
[`tests/agents-catalog.test.ts`](../tests/agents-catalog.test.ts).

## Reuse one Sandbox within a stage

Spec-to-PR runs the implementer, verification, and every repair run in one
Sandbox. Repairs see the same working tree without publishing or restoring it
between calls. PR Reviewer likewise runs verification and its reviewer against one
exact checkout.

This is a useful unit-of-isolation rule:

- use a fresh Sandbox for each independently authorized stage;
- reuse that Sandbox for related work in the same stage and on the same
  checkout;
- never reuse it across issues, PRs, or human approval boundaries.

Implementation:
[`app/workflows/pr-review/index.ts`](../app/workflows/pr-review/index.ts) and
[`app/workflows/pr-review/agents.ts`](../app/workflows/pr-review/agents.ts).

## Keep write authority outside the agent environment

The Sandbox can propose bytes but cannot publish them. No GitHub write token
enters it.

Collection stages the candidate tree in a throwaway Git directory, preventing
agent-written hooks, config, or replacement refs from influencing the result.
The trusted host then:

1. validates paths, file modes, counts, sizes, and blob hashes;
2. asks GitHub to build the tree independently;
3. requires GitHub's tree SHA to equal the Sandbox's tree SHA;
4. checks branch ownership; and
5. only then moves a ref and opens a draft PR.

Generalize this as **proposal versus authority**:

- let an agent produce a candidate artifact;
- validate it against independent ground truth;
- reconstruct trusted identifiers and destinations outside the agent; and
- grant the smallest host component the authority to commit the effect.

Implementation:
[`sandbox/collect-changes.sh`](../sandbox/collect-changes.sh),
[`app/changeset/changes.ts`](../app/changeset/changes.ts), and
[`app/changeset/index.ts`](../app/changeset/index.ts).

## Treat guardrails and boundaries differently

The read-only shell policy rejects obvious mutation and network commands for
agents without write tools. That steers the model and avoids wasted turns,
but approximate command filtering is not a security boundary.

Use soft guardrails for:

- clear feedback and supported behavior;
- avoiding accidental or expensive actions; and
- reducing low-effort prompt-injection effects.

Use hard boundaries for:

- tool placement: Sandbox versus Workflows host;
- privilege: unprivileged Sandbox user;
- write authority: no GitHub write credential in the Sandbox;
- destination choice: trusted task input and deterministic branches;
- lifetime: fresh Sandboxes, `finally`, and provider timeouts; and
- acceptance: host validation and tree-SHA equality.

Naming which layer enforces a property prevents a convenient policy from
quietly becoming the only defense.

Implementation:
[`app/runner/tools.ts`](../app/runner/tools.ts),
[`sandbox/as-runner.sh`](../sandbox/as-runner.sh), and
[`sandbox/verify.sh`](../sandbox/verify.sh).

## Verify real security properties before work

Setup code can partially fail, images can change, and restored state can
differ from the state that was snapshotted. Do not assume a sequence of API
calls produced the intended boundary.

`verify.sh` checks the actual layout, ownership, permissions, credential
absence, runner, and process hardening:

- before a builder creates a snapshot; and
- after every stage Sandbox is restored.

The host separately refuses to send a model key unless it confirms the runner
is non-dumpable. A failed check produces no snapshot or no stage work.

Turn critical security claims into executable preconditions and test them
where the protected operation begins.

Implementation:
[`sandbox/verify.sh`](../sandbox/verify.sh) and
[`app/sandbox/verify.ts`](../app/sandbox/verify.ts).

## Use typed, bounded contracts around models

Every agent definition supplies a Zod output schema. The runner converts it
to the schema of one `submit` tool, permits bounded repair of invalid
submissions, and trusted host code validates the result again.

The rest of the system consumes domain values, not prose parsing:

- Triage returns a bounded decision and questions;
- the spec writer returns explicit spec sections;
- the implementer reports a bounded summary; and
- the PR reviewer returns one bounded review contract.

Bound lengths and array sizes because outputs reach external systems with
their own limits. Rebuild targets, identities, links, and permissions from
trusted state rather than accepting them from the model.

Implementation:
[`app/schemas/`](../app/schemas),
[`app/runner/submit.ts`](../app/runner/submit.ts), and
[`app/agents/run.ts`](../app/agents/run.ts).

## Bound agents by turns and time, not dollars

Providers report cost after a response, so an in-process dollar threshold is
always soft: the response that crosses it is already charged. Rather than
thread a budget through every stage, each agent has a turn limit and a call
timeout, every stage has a bounded number of repair runs, and the model key
carries a provider-enforced spend limit.

Reported usage and cost are still recorded on every `agent.finished` event,
for successes and failures alike.

Implementation:
[`app/agents/run.ts`](../app/agents/run.ts) and
[`app/runner/session.ts`](../app/runner/session.ts).

## Separate coordination from observability

One event table serves two roles with deliberately different failure modes:

- `run.claimed` is part of correctness and fails closed;
- delivery, run, and agent events are telemetry and fail open.

This keeps useful history from becoming an accidental dependency while keeping
cross-task ownership durable. No stage reads telemetry back.

When one store contains both control and telemetry, make the distinction
visible in APIs and error handling. Avoid letting a convenient dashboard query
become hidden workflow state.

Implementation:
[`app/events/index.ts`](../app/events/index.ts).

## Residual risks

Layered controls reduce authority; they do not make arbitrary code and model
execution perfectly safe.

This project accepts and documents:

- a model key in the hardened runner's memory during a call;
- DNS as an exfiltration channel;
- spend initiated by any collaborator meeting `minimumPermission`;
- execution of labeled fork PR code during verification;
- prompt injection through issues, comments, code, and diffs;
- a Render API key whose authority may span the workspace;
- Postgres availability on the run-ownership path; and
- task inputs and results visible to Render Dashboard users.
