# Architecture

Agents inspect and modify repositories inside short-lived Render Sandboxes.
Code in the Workflows service validates their results and performs every
GitHub write.

## System

```mermaid
flowchart LR
  GitHub -->|signed webhook| Gateway
  Gateway -->|start task| Workflows
  Workflows -->|restore| Sandbox
  Sandbox -->|typed result or candidate tree| Workflows
  Workflows -->|validated write| GitHub
  Workflows -->|build| Snapshot
  Snapshot -.->|restore| Sandbox
```

The Blueprint deploys two services and a database:

- **Gateway** verifies webhooks, maps each delivery to one task, and streams
  the event log to readers.
- **Workflows** runs tasks, manages Sandboxes, and writes to GitHub.
- **Postgres** (`factory-db`) holds an append-only event log, including every
  agent run. Both services apply its migrations at startup.

The application does not implement its own queue, dispatcher, heartbeat
process, or maintenance loop.

## Workflow

```text
issue --factory:triage--> specification
specification --factory:spec-approved--> draft pull request
pull request --factory:pr-review--> COMMENT review
```

### Triage

Triage reads the issue discussion and the base branch. The triage agent asks
up to five questions, declines the request, or sends it to the spec-writing
agent. The spec-writing agent produces a bounded specification. Questions and
specifications are GitHub comments with hidden markers.

### Spec-to-PR

Spec-to-PR confirms that the approved specification has not changed. It
implements that specification in a Sandbox, runs the configured verification
commands, allows a bounded number of repairs, and opens a draft pull request
on `factory/issue-<number>`.

### PR Reviewer

PR Reviewer checks out the labeled pull request commit, runs the configured
verification commands, and posts one COMMENT review. The review covers
security, correctness, performance, and tests.

### Autopilot

Applying `factory:autopilot` grants upfront approval for Triage, Spec-to-PR, and PR Reviewer.
The parent starts each GitHub task with `ctx.run`, so every stage has its own compute, claim,
status, and Sandbox.

Autopilot does not apply the manual transition labels. Triage can still remove
a stale `factory:spec-approved` label when it revises a spec. Triage returns
the exact App-authored spec comment and content hash to Spec-to-PR, which
verifies that the current spec still matches. Spec-to-PR returns the pull
request number and head commit directly to PR Reviewer. If Triage asks
questions, the parent adds `factory:autopilot` back before it ends; a human
reply starts a new parent run. At other times the trigger label is absent, so
unrelated comments do not restart the workflow.

## State

Each system owns the state it already manages:

| State | Owner |
|---|---|
| Whether a task process is alive, and its input and result | Render Workflows |
| Issues, labels, specifications, pull requests, and reviews | GitHub |
| Deliveries, claims, task runs, their outcomes, and their Sandboxes | Postgres event log |
| Prepared repository filesystem | Render Sandbox snapshot |
| Agent runs: messages, tool calls, outcome, usage, and cost | Postgres event log |

The status comment on an issue or pull request is a view of the claim and the
current run, rendered from Postgres. Nothing reads it back, and nothing reads
agent run events to decide what a task may do: they are for people to watch.

### Event log

The `events` table in Postgres (`app/db/`) is append-only. Each event belongs
to a stream and takes the stream's next version. An append can require the
stream to be at an expected version, so two writers can't both act on the same
state. Events about an issue or pull request also record it as their subject.
Payloads are validated against the types declared in `app/events/catalog.ts`.

Projections are tables derived from the log, updated in the same transaction
as each append, and `npm run db:rebuild` replays the log to recreate them.
Listeners on the `events` channel hear of an event when its transaction
commits. Readers page one stream by version and a subject by transaction
order, so an event that commits late is never skipped.

## Coordination

Webhook delivery is not exactly once. GitHub can redeliver events, and people
can apply labels or post comments at the same time. The factory handles this
at three boundaries:

1. The gateway records each delivery in the log under its GitHub delivery ID,
   which is also the Workflows idempotency key. If Postgres is unavailable it
   returns 502, so GitHub marks the delivery failed and it can be redelivered.
2. The subject stream's version fences claims on an issue or pull request.
3. Hidden markers identify App-authored specifications, pull requests, and
   reviews so writes can update or reuse them.

A claim belongs to a trace: the root workflow run. It also names the trace's
current task run, which is the root or one of its children. A child continues
its root's claim and may not take over another's. Cancellation stops the root
and closes the current child.

A new GitHub task run appends `claim.acquired` to the subject's stream at the
version it read, so of two runs that read the same claim only one appends; the
other rereads and tries again. After its claim commits, it cancels the
previous trace if Render still has it running, terminates the Sandboxes that
trace recorded, and records it stopped. Claiming first fences the previous
run even when cancelling it fails: it stops at its next ownership check.

GitHub tasks check ownership immediately before progress updates and durable
writes. The GitHub write happens after the check, outside the transaction, so a
run can still lose its claim in between. Publishing also uses a deterministic
branch and refuses to overwrite human commits.

Render Workflows decides whether a task process is alive. Render can cancel a
task without running its `finally`, which leaves its run recorded as running
and its claim held until the next claim or `/factory cancel` closes it. There
is no sweeper.

The status comment and `factory:working` are synced from Postgres after each
claim, progress update, and finish. A GitHub failure while syncing is logged
and never fails the run; the final sync retries. Editing or deleting the
comment can't change who owns the subject.

### Upgrading from status-comment claims

Before this release, the status comment was the claim. The upgrade does not
read old comments: let running factory tasks finish, or cancel them, before
deploying both services. The first run on each issue or pull request after the
upgrade posts a new status comment.

## Sandboxes and snapshots

A base-branch push builds a repository snapshot with the runner, a base
checkout, and installed dependencies. A GitHub task then:

1. restores the newest snapshot;
2. replaces the snapshot's runner bundle with this deployment's when their
   hashes differ, root-owned and read-only to the runner user;
3. verifies runtime permissions and process hardening;
4. fetches the exact requested ref with a temporary read-only token;
5. removes the token and verifies its removal;
6. reinstalls dependencies when the lockfiles or install command changed;
7. runs agents and repository commands as an unprivileged user; and
8. closes the Sandbox in `finally`.

Render terminates a cancelled task without running `finally`. For that case,
each GitHub task records its Sandbox ID in Postgres. A replacement run or
`/factory cancel` terminates the recorded Sandbox. The provider timeout
is the final cleanup backstop.

Snapshots avoid reinstalling dependencies on every run. Restored Sandboxes
still fetch the requested commit and verify their current state; a snapshot is
prepared state, not trusted current state.

## Agents

An agent definition fixes:

- its prompt;
- its harness: the agent library and model that run it;
- available tools;
- output schema;
- turn limit; and
- stable ID.

The model loop and every model-directed tool run in the Sandbox beside the
checkout. Agent tools never run on the Workflows host.

A harness adapter in `app/harness/` wraps an agent library's own
configuration. Agent definitions and their harnesses are bundled into the
Sandbox runner, which runs the agent named in its input on that agent's
harness. The host and the runner speak a versioned contract
(`app/runner/core/protocol.ts`): JSON on stdin, with the key on the first line,
and JSON Lines events on stdout. Every harness gives the model the factory's
own tools and `submit`, so tool authority and the read-only shell policy don't
depend on the library. In the runner, a kernel owns each run: its events, turn
and time limits, tools, and submission. A harness's driver only translates its
library.

Every agent finishes through a typed `submit` tool. The runner validates the
submission against JSON Schema. The host validates it again with the agent's
Zod schema. Repositories, refs, issue numbers, pull requests, branches, and
write targets come from authenticated task input, never model output.

### Agent run events

`runAgent` records every agent run in the event log as an `agent_run:<id>`
stream, whose subject is the task's issue or pull request. A recorder on the
Workflows host (`app/events/recorder.ts`) is the stream's only writer. It
translates the runner's events into `assistant.message`, `tool.call`,
`tool.result`, and `usage` events and writes them every 250 ms in one
transaction. Until the runner reports live, the host feeds it the downloaded
output after the run. Runner output is untrusted: it becomes display events on
the run's own stream and nothing else. `agent_run.finished`, with the outcome,
turns, usage, and cost, comes from the host's own summary of the run, and the
`agent_runs` table projects it. A database error never fails the agent run;
the recorder keeps a bounded queue and logs what it couldn't write.

The model's text as it streams travels as `NOTIFY` messages on the `live`
channel, sent in the recorder's transactions and never stored. Each gateway
instance holds one `LISTEN` connection for `events` and `live`
(`app/gateway/hub.ts`) and keeps the text so far of every in-progress message
in memory, so instances serve the same streams without sharing state. A
notification only wakes readers, which then read from their own cursors, and
readers also poll every 5 seconds, so a missed notification costs latency,
never an event. A missed delta is lost; the final message is in the log.

The gateway streams one agent run, or everything on an issue or pull request,
as server-sent events to holders of `EVENTS_READ_TOKEN` (`app/gateway/stream.ts`).
Each stream's event IDs are its log cursors: the stream version for an agent
run, and `<tx>-<seq>` for a subject.

## Publishing

The Sandbox has no GitHub write credential. It returns a candidate tree to
the Workflows host, which:

1. collects changes through a throwaway Git directory;
2. validates paths, modes, file counts, sizes, and blob hashes;
3. rejects workflow files, symlinks, and submodules;
4. asks GitHub to build the same tree;
5. compares GitHub's tree SHA with the Sandbox tree SHA; and
6. moves the deterministic branch only when the factory still owns it.

## Trust boundaries

Issue text, comments, source files, dependency scripts, and pull request diffs
are untrusted.

### Gateway

The gateway verifies the webhook signature before parsing the body. It holds
no GitHub credential and runs no model or repository code. It holds the
database credential. It serves event streams only to requests that present
`EVENTS_READ_TOKEN`, compared in constant time.

### Workflows host

The Workflows service holds GitHub, Render, and database credentials. It
selects every destination, checks claim ownership, validates Sandbox output,
and performs GitHub writes.

### Sandbox

Clone and fetch credentials are read-only and temporary. Runtime files are
root-owned and read-only. Agents and repository commands run as an
unprivileged user.

Every Sandbox is created with an HTTPS egress allow-list built by the
Workflows host from trusted configuration. Task Sandboxes reach `github.com`,
the agents' model APIs, and the repository's configured `egress` hosts. The
snapshot builder reaches `github.com`, Debian's package mirror, and the
repository's hosts. Render enforces the list outside the Sandbox and fixes it
at creation, so nothing inside the Sandbox can widen it. See
[Sandbox egress](configuration.md#sandbox-egress).

The model key enters the Sandbox during an agent call. The runner receives it
through a root-only path and stdin, removes provider keys from tool
environments, and runs under a non-dumpable Node binary. These controls and
the allow-list reduce exposure; they do not make untrusted code safe.

## Security invariants

Changes must preserve these properties:

1. Verify a webhook signature before parsing its body.
2. Check the triggering actor's current repository permission for every
   GitHub task run.
3. Let only code in the Workflows service write to GitHub.
4. Keep GitHub write credentials out of Sandboxes.
5. Run every model-directed tool inside a Sandbox.
6. Build repositories, refs, branches, and write targets from trusted input.
7. Publish only after GitHub reproduces the validated tree SHA.
8. Stop automation at a draft pull request and a COMMENT review.
9. Implement the specification as it existed when approved.
10. Give every Sandbox a provider timeout and `finally` cleanup. Record a
    GitHub task's Sandbox in Postgres before its next ownership check, so
    cancellation can terminate it.
11. Create every Sandbox with an egress allow-list built from trusted
    configuration. Only a repository's configured `egress: "allow-all"` lifts it.
12. Give database credentials only to the gateway and Workflows services.
    Nothing in a Sandbox holds one or writes events.
13. Treat runner output as untrusted: record it only as display events on its
    own agent run, and take outcomes and costs from the host's summary.

Tests pin these invariants and the tool authority of every built-in agent.

## Residual risks

- Allowed hosts remain exfiltration paths. Code in a Sandbox can send data to
  an attacker's own GitHub account or model API account through `github.com`
  or the model API, and to anything a wildcard rule admits. Task Sandboxes
  keep `github.com` for their whole lifetime because the policy can't change
  after the fetch.
- DNS resolution is not restricted by the allow-list.
- A repository configured with `egress: "allow-all"` has unrestricted egress.
- The model key exists in runner memory during a call.
- Prompt injection can influence specifications, code, and reviews.
- Anyone with `minimumPermission` can start model spend.
- PR Reviewer runs repository-defined commands from the labeled pull request.
- The Render API key may have workspace-wide authority.
- The gateway's database credential can write factory state, so a compromised
  gateway can forge events. Before the database, it held only the webhook
  secret and the Render API key.
- Anyone with `EVENTS_READ_TOKEN` can read every agent run's messages and tool
  output, for every repository. Readers share the one token.
- A process in a Sandbox that forges runner output can change what stream
  readers see, though not what the task does or what the run cost.
- Near-simultaneous triggers can both work until one fails its next ownership
  check.
- Workflows inputs and results are visible to people with service access.
- Telemetry can include repository names, issue subjects, and errors that
  quote repository output.
- The filesystem of each deployed Render service is ephemeral. Durable state
  belongs in GitHub, Workflows, Postgres, or Sandbox snapshots.
- A cancelled snapshot build can leave its builder Sandbox running until the
  one-hour provider timeout because builders are not recorded.

Use a dedicated Render workspace and a spend-capped model key when stronger
isolation matters.

Expected work failures produce a useful status-comment result. Unexpected
platform or programming failures fail the Workflows task and require
operator investigation.

## Code map

Start with:

1. [`app/gateway/routes.ts`](../app/gateway/routes.ts) — webhook-to-task
   routing.
2. [`app/workflows/github-task.ts`](../app/workflows/github-task.ts) —
   GitHub task declaration.
3. [`app/claims/claim.ts`](../app/claims/claim.ts) — permission, ownership,
   progress, and completion; [`app/claims/status.ts`](../app/claims/status.ts)
   — claims, stopping runs, and the status comment view.
4. [`app/workflows/triage/index.ts`](../app/workflows/triage/index.ts) — one
   complete GitHub task.
5. [`app/workflows/autopilot/index.ts`](../app/workflows/autopilot/index.ts) —
   parent/subtask orchestration.
6. [`app/agents/run.ts`](../app/agents/run.ts) — host-side agent execution.
7. [`app/runner/main.ts`](../app/runner/main.ts) — Sandbox runner entry point;
   [`app/harness/`](../app/harness/) — agent library adapters.
8. [`app/sandbox/sandbox.ts`](../app/sandbox/sandbox.ts) — Sandbox lifecycle.
9. [`app/changeset/index.ts`](../app/changeset/index.ts) — validated
   publishing.
10. [`app/db/store.ts`](../app/db/store.ts) — appending to the event log;
    [`app/db/read.ts`](../app/db/read.ts) — reading it in order.
11. [`app/events/recorder.ts`](../app/events/recorder.ts) — recording an agent
    run; [`app/gateway/stream.ts`](../app/gateway/stream.ts) — streaming it.

Use the [extension runbook](runbooks/extend.md) to add agents, tasks, or
triggers.
