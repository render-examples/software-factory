# Setup runbook

Use this runbook when helping someone deploy Software Factory for the first
time. Follow it in order. Do not claim setup is complete until both deployed
services pass `doctor` and a labeled issue produces a factory status comment.

## Goal

Deploy Software Factory from the user's fork, connect it to one GitHub
repository, and complete one Triage run.

## Success criteria

Setup is complete only when:

- `factory-gateway`, `factory-workflows`, and `factory-db` are live;
- the GitHub App is installed on every configured repository;
- the App webhook is active and points to the gateway;
- the factory labels exist;
- deployed `doctor` checks pass for the gateway and Workflows services; and
- applying `factory:triage` produces an App-authored status comment.

## Required inputs

Collect or infer these before editing:

- fork owner and repository;
- target repository in `owner/name` form;
- target base branch;
- deterministic dependency install command, if needed;
- verification commands;
- GitHub App owner: the user or an organization;
- Render workspace with Sandboxes access in Oregon; and
- whether the default Anthropic models are acceptable.

The user must provide these secrets directly to local environment files or
Render—not in chat, issues, commits, or command output:

- Render API key;
- model provider API key; and
- generated GitHub App private key and webhook secret.

## Non-negotiable constraints

- Deploy from the user's fork, not `render-examples/software-factory`.
- Use the Node.js version pinned in `.node-version`.
- Never commit `.env` or print secret values.
- Do not weaken GitHub App permissions or security invariants to make setup
  pass.
- Do not change existing GitHub App permissions, Render resources, or paid
  plans without explaining the effect and receiving approval.
- Do not create a test issue or apply a label without the user's approval.
- Stop at every **Human checkpoint** until the user confirms completion.
- Preserve unrelated working-tree changes.

## Phase 1: Inspect and preflight

### Agent action

Confirm the current directory is the Software Factory root and inspect:

- `.node-version`;
- `package.json`;
- `factory.config.ts`;
- `render.yaml`;
- `.env.example`; and
- the current Git status.

Run:

```bash
node --version
npm ci
npm run check
```

### Pass condition

- Node satisfies the pinned project version.
- Dependencies install successfully.
- Lint, type checking, and tests pass.
- Existing unrelated changes have been identified and left untouched.

### Recovery

- Wrong Node version: install or select the version in `.node-version`, then
  rerun the phase.
- `npm ci` failure: report the failing command and relevant error; do not
  replace it with a lockfile-changing install.
- Existing test failure: distinguish it from changes made during setup before
  continuing.

## Phase 2: Configure one repository

### Agent action

Edit `factory.config.ts` so `repos` contains the intended targets:

```typescript
repos: {
  "acme/web": {
    baseBranch: "main",
    install: "npm ci",
    verify: ["npm run build", "npm test"],
  },
},
```

Rules:

- The key must be the exact GitHub `owner/name`.
- `baseBranch` must already exist.
- `install` must be deterministic and must not change tracked files.
- `verify` must contain the commands required before publishing. Use an empty
  list only when skipping command-based verification is intentional.

Keep the default labels, permission, limits, and Sandbox timeout unless the
user requested a change.

Run:

```bash
npm run typecheck
git diff --check
```

### Pass condition

- Configuration parses and type-checks.
- The diff contains only the intended repository and explicitly requested
  behavior changes.

### Recovery

Use [Configuration](../configuration.md) for field semantics. If install or
verification commands are unknown, stop and ask the user; do not guess
project-specific commands when the target repository does not establish
them.

## Phase 3: Save the fork

### Agent action

Confirm the repository remote points to the user's fork. Present the
configuration diff and verification result.

Commit and push only when the user has asked the agent to do so. The Render
Blueprint must be able to read the committed configuration from the fork.

### Human checkpoint: fork ownership and push

The user must confirm:

- the destination fork is correct;
- the configuration is safe to deploy; and
- the configured commit is available on the fork's deployment branch.

### Pass condition

The fork contains the intended `factory.config.ts` and `render.yaml`.

## Phase 4: Create the GitHub App

### Agent action

Install local dependencies if needed, then start the manifest flow:

```bash
npm run setup:app -- --write-env
```

For an organization-owned App:

```bash
npm run setup:app -- --org <organization> --write-env
```

The command starts a local callback server and prints a browser URL. Keep it
running while the user completes the checkpoint.

### Human checkpoint: create the App

Ask the user to:

1. open the printed local URL;
2. review the App name, repositories, permissions, and events;
3. select **Create on GitHub**; and
4. return when the command reports success.

The manifest requests:

- Contents, Issues, and Pull requests: write;
- Metadata: read; and
- Issues, Issue comments, Pull requests, and Pushes events.

It does not request Actions, Workflows, or Administration permission.

### Agent verification

Confirm the command:

- reports the App slug and ID;
- prints an installation URL;
- writes `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
  `GITHUB_WEBHOOK_SECRET` to `.env`; and
- exits successfully.

Verify that Git ignores the file:

```bash
git check-ignore .env
```

Do not display `.env`.

### Pass condition

The GitHub App exists, `.env` is ignored, and the three generated values are
available locally without being exposed.

## Phase 5: Install the GitHub App

### Human checkpoint: repository installation

Ask the user to open the installation URL printed by `setup:app` and install
the App on every repository in `factory.config.ts`.

When organization approval is required, stop until an organization owner has
approved the installation.

### Pass condition

The user confirms installation on every exact configured repository.

## Phase 6: Deploy the Render Blueprint

### Agent action

Explain that [`render.yaml`](../../render.yaml) creates paid resources in
Oregon:

- `factory-gateway`, a Starter web service;
- `factory-workflows`, a Workflows service; and
- `factory-db`, a Basic-256mb Postgres database.

The user should create the Blueprint from the configured fork and deployment
branch.

### Human checkpoint: paid resources and secrets

Before creation, ask the user to confirm the resources and expected charges.
Then ask them to enter every `sync: false` value in the Render Dashboard.

For `factory-gateway`:

- `GITHUB_WEBHOOK_SECRET`
- `RENDER_API_KEY`

For `factory-workflows`:

- `RENDER_API_KEY`
- `RENDER_WORKSPACE_ID`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `ANTHROPIC_API_KEY`

The user should copy GitHub values from the local `.env` without pasting them
into chat. The Render workspace ID starts with `tea-`.

### Pass condition

All three resources are created, the gateway reports live, and the Workflows
service has deployed successfully.

### Recovery

- Blank `sync: false` field: set the missing value and redeploy.
- Build failure: inspect the failing service's build log before changing
  configuration.
- Pre-deploy migration failure: verify the Blueprint's `DATABASE_URL` wiring
  and database health.
- Port or health failure: confirm the gateway binds to `0.0.0.0:$PORT` and
  serves `/ready`.

Use [Operations](../operations.md#troubleshoot) for service-specific failures.

## Phase 7: Connect the webhook and create labels

### Agent action

Ask the user for the public gateway URL; this URL is not a secret. Run:

```bash
npm run setup:github -- \
  --gateway-url https://<gateway>.onrender.com
```

The command reads GitHub credentials from `.env`. It is idempotent and should:

- set the App webhook URL to
  `https://<gateway>.onrender.com/webhooks/github`;
- preserve the generated webhook secret; and
- create `factory:triage`, `factory:spec-approved`,
  `factory:pr-review`, and `factory:working` in each configured repository.

### Pass condition

The command exits successfully and reports no failed repository or webhook
operation.

### Recovery

- Missing credentials: confirm `setup:app --write-env` completed and `.env`
  exists without printing it.
- Repository failure: confirm exact `owner/name`, App installation, and the
  installing user's repository administration access.
- Wrong gateway URL: use the public HTTPS URL for `factory-gateway`, without
  adding `/webhooks/github`; the command adds the path.

## Phase 8: Activate the webhook

GitHub's API does not allow `setup:github` to activate an App webhook.

### Human checkpoint: webhook activation

Ask the user to:

1. open the GitHub App settings;
2. open **Webhook**;
3. verify the URL ends in `/webhooks/github`;
4. enable **Active**; and
5. save without changing the URL or secret.

### Pass condition

The user confirms the webhook is active.

## Phase 9: Verify the deployed services

Run `doctor` inside each service's Render Shell so it reads that service's
deployed environment.

### Human checkpoint or agent action with Render access

In `factory-gateway`:

```bash
npm run doctor -- --service gateway
```

In `factory-workflows`:

```bash
npm run doctor -- --service workflows
```

`doctor` is read-only and does not print secret values.

### Pass condition

Both commands exit successfully with every required check passing.

### Recovery

- Gateway failure: check webhook secret, Render API key, workflow slug, and
  database connection.
- Workflows failure: check Render workspace ID, Render API key, GitHub App
  credentials, provider key, database, and registered tasks.
- App failure: compare required permissions and events with Phase 4.
- Label or installation failure: rerun `npm run setup:github` after fixing
  App access.

Do not proceed to the smoke test while either service fails `doctor`.

## Phase 10: Smoke-test Triage

### Human checkpoint: external write

Ask permission before creating an issue or modifying labels. Use a small,
disposable issue in a configured test repository.

Suggested issue:

```text
Title: Software Factory setup smoke test

Confirm the repository can be inspected and return a minimal specification.
Do not request a code change.
```

Create the issue and apply `factory:triage`. This can be done in GitHub or,
when the user has approved CLI writes:

```bash
gh issue create \
  --repo <owner/name> \
  --title "Software Factory setup smoke test" \
  --body "Confirm the repository can be inspected and return a minimal specification. Do not request a code change."

gh issue edit <number> \
  --repo <owner/name> \
  --add-label factory:triage
```

The first run may take several minutes while it builds the repository
snapshot.

### Pass condition

- The issue receives an App-authored status comment.
- `factory:working` appears while the task is running.
- Triage ends with questions, a specification, or an intentional decline.
- The status comment includes the final outcome or a useful failure.

If the status comment never appears, use
[Operations](../operations.md#no-status-comment).

## Phase 11: Handoff

Report setup using this format without including secrets:

```text
Software Factory setup: complete

Fork: <URL>
Configured repositories: <owner/name, ...>
Gateway: <URL>
GitHub App: <settings or public URL>
Gateway doctor: passed
Workflows doctor: passed
Triage smoke test: <issue URL and outcome>

Local uncommitted changes: <none or summary>
Follow-up actions: <none or explicit list>
```

If any success criterion is missing, report setup as **incomplete** and name
the exact checkpoint, evidence, and next action.

## Ready to extend

After setup:

- add or change repositories, labels, models, and limits through
  [Configuration](../configuration.md);
- diagnose live behavior through [Operations](../operations.md);
- read [Architecture](../architecture.md) before changing authority,
  credentials, coordination, or publishing; and
- use [Contributing](../../CONTRIBUTING.md) to add agents, tasks, and GitHub
  triggers.
