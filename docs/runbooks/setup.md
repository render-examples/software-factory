# Setup runbook

Use this runbook to deploy software-factory from a fork and connect its first
repository. Follow the phases in order. Stop at every **Human checkpoint**.

Setup is complete only after gateway `doctor` passes in its Render Shell,
Workflows `doctor` passes locally with the deployed values, and a Triage smoke
test reaches an App-authored status comment.

## Inputs

Collect:

- fork owner and repository;
- target repository in `owner/name` form;
- target base branch;
- deterministic dependency install command, if needed;
- verification commands;
- GitHub App owner: a user or organization;
- Render workspace with Sandboxes access in Oregon; and
- confirmation that the default Anthropic models are acceptable.

The user must enter these secrets directly in local files, GitHub, or Render:

- Render API key;
- Anthropic API key;
- GitHub App private key; and
- webhook secret.

Never ask the user to paste a secret into chat. Never print `.env`.

## Rules

- Deploy from the user's fork, not `render-examples/software-factory`.
- Use the Node.js version in `.node-version`.
- Preserve unrelated working-tree changes.
- Do not guess repository install or verification commands.
- Do not weaken App permissions or security checks to make setup pass.
- Ask before committing, pushing, creating paid resources, changing external
  settings, creating issues, or applying labels.

## Phase 1: Preflight

Confirm that the current directory is the software-factory root. Inspect:

- `.node-version`;
- `package.json`;
- `factory.config.ts`;
- `render.yaml`;
- `.env.example`; and
- Git status.

Run:

```bash
node --version
npm ci
npm run check
```

Continue only when the pinned Node version is active, dependencies install,
checks pass, and unrelated changes are accounted for. Do not replace a failed
`npm ci` with a lockfile-changing install.

## Phase 2: Configure repositories

Replace the example `repos` entry in `factory.config.ts`:

```typescript
repos: {
  "acme/web": {
    baseBranch: "main",
    install: "npm ci",
    verify: ["npm run build", "npm test"],
  },
},
```

Requirements:

- use the exact GitHub `owner/name`;
- name an existing base branch;
- use an install command that is deterministic and leaves tracked files
  unchanged; and
- list every command required before publishing.

Use `verify: []` only when the user explicitly wants no command-based
verification. Keep the default labels, permission, limits, and Sandbox timeout
unless the user requested changes.

Run:

```bash
npm run typecheck
git diff --check
```

Use [Configuration](../configuration.md) for field semantics.

## Phase 3: Publish the configured fork

Confirm that the Git remote points to the user's fork. Show the configuration
diff and check results.

### Human checkpoint: commit and push

Ask the user to confirm:

- the destination fork and branch;
- the configured repositories and commands; and
- permission to commit and push, if not already granted.

Do not continue until the deployment branch on the fork contains the intended
`factory.config.ts` and `render.yaml`. The Blueprint reads these files from
that branch.

## Phase 4: Create the GitHub App

Start the GitHub App manifest flow:

```bash
npm run setup:app -- --write-env
```

For an organization-owned App:

```bash
npm run setup:app -- --org <organization> --write-env
```

Keep the command running while the user completes the browser flow.

### Human checkpoint: create the App

Ask the user to open the printed URL, review the manifest, and select
**Create on GitHub**.

The manifest requests:

- Contents, Issues, and Pull requests: write;
- Metadata: read; and
- Issues, Issue comments, Pull requests, and Pushes events.

It does not request GitHub Actions, GitHub Workflows, or Administration
permission.

After the callback completes, confirm that the command reports the App slug
and ID, prints an installation URL, and writes these values to `.env`:

- `GITHUB_APP_ID`;
- `GITHUB_APP_PRIVATE_KEY`; and
- `GITHUB_WEBHOOK_SECRET`.

Verify that Git ignores the file:

```bash
git check-ignore .env
```

## Phase 5: Install the App

### Human checkpoint: repository access

Ask the user to open the installation URL and install the App on every
repository in `factory.config.ts`. If an organization requires approval, wait
for an owner to approve the installation.

Continue only after the user confirms access to every configured repository.

## Phase 6: Deploy the Blueprint

[`render.yaml`](../../render.yaml) creates two paid resources in the
`production` environment of a `software-factory` project:

- `factory-gateway`, a Starter web service in Oregon; and
- `factory-workflows`, a Workflows service in Oregon.

### Human checkpoint: resources and secrets

Explain the resources and expected charges. Ask the user to create the
Blueprint from the configured fork and branch.

Enter these values for `factory-gateway`:

- `GITHUB_WEBHOOK_SECRET`;
- `RENDER_API_KEY`.

Enter these values for `factory-workflows`:

- `RENDER_API_KEY`;
- `RENDER_WORKSPACE_ID`;
- `GITHUB_APP_ID`;
- `GITHUB_APP_PRIVATE_KEY`;
- `ANTHROPIC_API_KEY`.

The workspace ID starts with `tea-`. Copy GitHub values from local `.env`
without showing them in chat or command output.

Continue when both services have deployed and the gateway is live.

## Phase 7: Configure GitHub

Ask for the public gateway URL. It is not a secret. Run:

```bash
npm run setup:github -- \
  --gateway-url https://<gateway>.onrender.com
```

The command:

- sets the App webhook URL to
  `https://<gateway>.onrender.com/webhooks/github`;
- preserves the generated webhook secret; and
- creates `factory:triage`, `factory:spec-approved`,
  `factory:pr-review`, `factory:autopilot`, and `factory:working`.

It is safe to rerun. Continue only when it reports no failed repository or
webhook operation.

## Phase 8: Activate the webhook

`setup:github` cannot activate an App webhook through GitHub's API.

### Human checkpoint: webhook activation

Ask the user to open the App's **Webhook** settings, confirm that the URL ends
in `/webhooks/github`, enable **Active**, and save without changing the secret.

## Phase 9: Run `doctor`

`doctor` checks the environment in which it runs. It is read-only and does
not print secret values.

### Gateway

Run this in the `factory-gateway` Render Shell:

```bash
npm run doctor -- --service gateway
```

This checks the gateway's deployed environment.

### Workflows

Workflows services have no Shell. Run `doctor` locally with the values used by
`factory-workflows`.

Local `.env` already contains the GitHub App values. Ask the user to add:

- `RENDER_API_KEY`;
- `RENDER_WORKSPACE_ID`;
- `ANTHROPIC_API_KEY`; and
- `RENDER_WORKFLOW_SLUG`.

Use the deployed workflow slug, including any suffix Render added. Copy the
exact value from `factory-gateway`'s deployed `RENDER_WORKFLOW_SLUG` into
local `.env`.

Run:

```bash
npm run doctor -- --service workflows
```

The warning `no webhook deliveries yet, so the hook may be inactive` is
expected before the smoke test. Do not continue while either command has a
failed check.

## Phase 10: Smoke-test Triage

### Human checkpoint: issue and label

Ask before creating an issue or changing labels. Use a disposable issue in a
configured test repository:

```text
Title: software-factory setup smoke test

Confirm the repository can be inspected and return a minimal specification.
Do not request a code change.
```

After approval, create and label it in GitHub or with `gh`:

```bash
gh issue create \
  --repo <owner/name> \
  --title "software-factory setup smoke test" \
  --body "Confirm the repository can be inspected and return a minimal specification. Do not request a code change."

gh issue edit <number> \
  --repo <owner/name> \
  --add-label factory:triage
```

The first run may spend several minutes building the repository snapshot.

The smoke test passes when:

- the issue receives an App-authored status comment;
- `factory:working` appears while the task runs;
- Triage ends with questions, a specification, or an intentional decline;
  and
- the status comment shows the final outcome or a useful failure.

Optionally confirm that the Workflows logs contain `run.finished`:

```bash
render logs -r <factory-workflows-id> --text run.finished
```

## Troubleshooting setup

### A service does not deploy

- For a missing `sync: false` value, set it and redeploy.
- For a build failure, inspect the failing service's build log before changing
  configuration.
- For a gateway health failure, confirm that it binds to `0.0.0.0:$PORT` and
  serves `/ready`.

### `doctor` fails

- Gateway: check the webhook secret, Render API key, and workflow slug.
- Workflows: check the workspace ID, Render API key, App credentials,
  provider key, and registered tasks.
- `No tasks found`: use the deployed workflow slug, not an assumed service
  name.
- App or label failure: fix App access and rerun `npm run setup:github`.

### No status comment appears

Open the App's **Advanced** settings and inspect **Recent Deliveries**.

- No delivery: activate the webhook and verify its URL.
- `401`: GitHub and `factory-gateway` have different webhook secrets.
- `422`: inspect the gateway log entry
  `authenticated delivery produced an invalid task input`.
- `502`: inspect `could not start task`; then check `RENDER_API_KEY`,
  `RENDER_WORKFLOW_SLUG`, and the Workflows deployment.
- `200` with `{"ignored":"<reason>"}`: the event did not start a task. Common
  reasons are `unconfigured repo`, `unhandled label`, `issue not in triage`,
  `bot sender`, `pull request not open`, and `not base branch`.
- `202`: the task started; inspect it under `factory-workflows`.

If a task starts but the comment says it did not run, the triggering actor
lacks `minimumPermission`.

### A snapshot build fails

Inspect the `refresh-snapshot` run or the first task run. Check the install
command, tracked-file changes after install, App installation, and Sandbox
verification.

### An agent submits an invalid result

The runner accepts three attempts. Search Workflows logs for the last schema
errors and submitted field names:

```bash
render logs -r <factory-workflows-id> --text invalid_submission
```

Repeated errors for one agent usually require a prompt or schema change.

### An agent cannot start

Check the selected provider key on `factory-workflows`, then run:

```bash
npm run doctor -- --service workflows
```

### Publishing refuses a change

Inspect the task logs. Publishing rejects workflow files, unsafe paths,
symlinks, submodules, file-count and file-size limits, branches with human
commits, and candidate trees GitHub cannot reproduce by SHA.

### The status comment remains on `running`

Post `/factory cancel` as the first line of a comment. This clears stale
status and terminates the recorded Sandbox. Reapplying the trigger label
starts a new run.

## Handoff

Report:

```text
software-factory setup: complete

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

If any required check is missing, report setup as **incomplete**. Name the
failed phase, evidence, and next action.

For later changes, use [Configuration](../configuration.md) or the
[extension runbook](extend.md).
