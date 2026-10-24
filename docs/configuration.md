# Configuration

[`factory.config.ts`](../factory.config.ts) is the factory's committed
application configuration. Both deployed services import it.

## Complete example

```typescript
export default defineFactoryConfig({
  repos: {
    "acme/web": {
      baseBranch: "main",
      install: "npm ci",
      verify: ["npm run build", "npm test"],
    },
    "acme/api": {
      baseBranch: "main",
      install: "go mod download",
      verify: ["go test ./..."],
    },
  },
  labels: {
    triage: "factory:triage",
    specApproved: "factory:spec-approved",
    prReview: "factory:pr-review",
  },
  commandPrefix: "/factory",
  minimumPermission: "write",
  models: {
    medium: "anthropic/claude-sonnet-5",
    large: "anthropic/claude-opus-5",
  },
  limits: {
    repairRounds: 2,
    maxChangedFiles: 200,
    maxFileBytes: 1_000_000,
  },
  sandbox: {
    timeoutSeconds: 4 * 60 * 60,
  },
});
```

## Repositories

`repos` is keyed by exact `owner/name`. Webhooks from any other repository
are ignored, even when the App is installed there.

| Field | Required | Purpose |
|---|---|---|
| `baseBranch` | Yes | Branch used for Triage, implementation, and snapshots |
| `install` | No | Dependency command run after repository credentials are removed |
| `verify` | Yes | Commands required before publishing and run during PR review |

Use deterministic install commands such as `npm ci`. Snapshot creation fails
if installation changes a tracked file. An empty `verify` list explicitly
disables command-based verification.

After adding a repository:

1. commit and deploy `factory.config.ts`;
2. install the GitHub App on the repository;
3. run `npm run setup:github`; and
4. apply a factory label or push to the base branch to build its first snapshot.

## Behavior and limits

| Setting | Default | Purpose |
|---|---|---|
| `labels.triage` | `factory:triage` | Starts or continues Triage |
| `labels.specApproved` | `factory:spec-approved` | Starts Spec-to-PR |
| `labels.prReview` | `factory:pr-review` | Starts PR Reviewer |
| `commandPrefix` | `/factory` | Prefix for commands such as `/factory cancel` |
| `minimumPermission` | `write` | Required live GitHub permission |
| `models.medium` | `anthropic/claude-sonnet-5` | Triage and PR Reviewer model |
| `models.large` | `anthropic/claude-opus-5` | Spec writer and implementer model |
| `limits.repairRounds` | `2` | Repair attempts after failed verification |
| `limits.maxChangedFiles` | `200` | Maximum files in a published change |
| `limits.maxFileBytes` | `1000000` | Maximum size of one changed file |
| `sandbox.timeoutSeconds` | `14400` | Provider-side Sandbox lifetime |

`setup:github` also creates `factory:working`, which marks an active run. It
is operational state rather than a configurable trigger label.

After renaming a label, deploy both services and rerun
`npm run setup:github`. Existing labels are not removed automatically.

Keep the Sandbox timeout at least as long as the longest Workflows task.

## Models

Each agent selects `medium` or `large`; configuration maps the tier to a
`provider/model` in Pi's model registry.

To change Anthropic models, update the mappings and redeploy the Workflows
service. To use another supported provider:

1. choose its registered `provider/model`;
2. find its key variable in [`app/runner/keys.ts`](../app/runner/keys.ts);
3. add the variable to the Workflows service in [`render.yaml`](../render.yaml);
4. add it to [`.env.example`](../.env.example) and setup requirements;
5. set the key in Render; and
6. run `npm run doctor -- --service workflows`.

Use a key dedicated to this factory with a provider-enforced spend limit.
Turn limits and timeouts bound execution, but the factory has no hard dollar
budget.

## Environment variables

Every local variable appears in [`.env.example`](../.env.example). The
Blueprint wires the gateway's reference to the Workflows service.

### Gateway

| Variable | Purpose |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | Verify GitHub webhook signatures |
| `RENDER_API_KEY` | Start Workflows tasks |
| `RENDER_WORKFLOW_SLUG` | Address the deployed Workflows service |
| `PORT` | HTTP port; defaults to `3000` |

### Workflows

| Variable | Purpose |
|---|---|
| `RENDER_API_KEY` | Manage Sandboxes, snapshots, and task cancellation |
| `RENDER_WORKSPACE_ID` | Workspace that owns Sandboxes and snapshots |
| `GITHUB_APP_ID` | Authenticate the GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Mint installation tokens |
| `ANTHROPIC_API_KEY` | Call the default models |
| `GITHUB_API_URL` | Optional GitHub API base URL |

`GITHUB_API_URL` is not declared by the Blueprint. GitHub Enterprise Server
users must set it in local `.env` for setup commands and manually on
`factory-workflows` in the Render Dashboard.

The gateway must bind to `0.0.0.0:$PORT` when deployed. Never commit `.env`
or provider keys.
