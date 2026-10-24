# Operations

Use this guide after completing the [Quickstart](quickstart.md).

## Follow a run

While a task is running, its issue or pull request has `factory:working`. The
factory's status comment shows progress, the current run ID, and final links.

Find that run under `factory-workflows` in the Render Dashboard to inspect
logs, inputs, and its result.

Every task run ends with a `run.finished` JSON line, and every agent run with
an `agent.finished` line, in the `factory-workflows` logs. Search for them, or
send them to a log stream:

```bash
render logs -r <factory-workflows id> --text agent.finished
```

`run.finished` carries the task, state, outcome, and duration. `agent.finished`
carries the agent, model, turns, token usage, reported cost, and, when an agent
is stopped, why. A run stopped by a newer run or by `/factory cancel` gets its
`run.finished` line from whatever stopped it, because Render kills a cancelled
run before it can write one. Task state remains in Render Workflows; GitHub remains the
source of truth for issues, specifications, pull requests, and reviews.

## Cancel or restart

To cancel, post this as the first line of an issue or pull request comment:

```text
/factory cancel
```

The commenter must have `minimumPermission`. Cancellation stops the run the
status comment names and terminates its Sandbox. Render kills a cancelled run
within about a second.

To restart a task, remove its trigger label and apply it again.

## Check a deployment

From a configured local checkout, this checks the credentials and services
named by your local `.env`:

```bash
npm run doctor
```

It does not inspect environment variables stored only on Render. To verify
each deployed service's actual environment, run `doctor` from its Render
Shell:

```bash
# factory-gateway
npm run doctor -- --service gateway

# factory-workflows
npm run doctor -- --service workflows
```

`doctor` is read-only, does not print secret values, and exits nonzero when a
required check fails.

## Understand snapshots

Each configured repository has a dependency-installed Sandbox snapshot. A
push to its base branch refreshes that snapshot. If no snapshot exists, the
first task to run builds one inline.

Configuration and code changes take effect at different times:

- `factory.config.ts`, application code, and prompt changes require a deploy.
- `app/runner/` and `sandbox/` changes require a snapshot refresh.
- A changed `install` command triggers reinstallation when a Sandbox opens;
  the next base-branch push bakes it into a new snapshot.
- Added repositories and renamed labels require `npm run setup:github`.
- GitHub permission or event changes require updating the App and rerunning
  `doctor`.

Snapshot refresh keeps the previous usable version when a new build fails.

## Troubleshoot

### No status comment

Inspect the GitHub App's recent webhook deliveries. Confirm:

- the webhook is active;
- its URL ends in `/webhooks/github`;
- the repository appears in `factory.config.ts`; and
- the triggering actor has `minimumPermission`.

### Webhook delivery returns 401

`GITHUB_WEBHOOK_SECRET` differs between GitHub and `factory-gateway`.

### Webhook delivery returns 502

The gateway could not start the task. Check `RENDER_API_KEY`,
`RENDER_WORKFLOW_SLUG`, and the Workflows service.

### Snapshot build fails

Inspect the `refresh-snapshot` run or the first task run. Common causes are:

- an invalid install command;
- installation changing tracked files;
- a missing App installation; or
- a Sandbox verification failure.

### Agent cannot start

Check the selected provider key in `factory-workflows`, then run:

```bash
npm run doctor -- --service workflows
```

### Publishing refuses a change

Inspect task logs for rejected workflow files, unsafe paths, symlinks,
submodules, file-count or size limits, branch ownership, or a tree-SHA
mismatch.

## Capacity, cost, and risk

- Sandbox API calls share the workspace's request limit. Expect a few
  concurrent tasks rather than dozens.
- The factory has no dollar budget. Use a dedicated, provider-capped model
  key.
- Anyone with `minimumPermission` can start model spend.
- PR Reviewer executes the labeled PR's configured verification commands.
- Sandboxes use allow-all egress.
- Local filesystem writes on Render services are ephemeral; durable state
  belongs in GitHub, Workflows, or Sandbox snapshots.

Review [Architecture](architecture.md#residual-risks) before using private
code or untrusted pull requests.
