# Configuration

The factory reads two kinds of configuration: `factory.config.ts`, committed with the code, and environment variables, set on each Render service (or in `.env` locally). Changing `factory.config.ts` takes a deploy of both services: the gateway routes with it and the Workflows service runs with it.

## `factory.config.ts`

```ts
export default defineFactoryConfig({
	repos: {
		"render-examples/render-factory-example-target": {
			baseBranch: "main",
			install: "npm ci",
			verify: ["npm run build", "npm test"],
		},
	},
	labels: { triage: "factory:triage", specApproved: "factory:spec-approved", prReview: "factory:pr-review" },
	commandPrefix: "/factory",
	minimumPermission: "write",
	models: { small: "anthropic/claude-haiku-4-5", medium: "anthropic/claude-sonnet-5", large: "anthropic/claude-opus-5" },
	limits: { perRunUsd: 20, repairRounds: 2, maxChangedFiles: 200, maxFileBytes: 1_000_000 },
	sandbox: { timeoutSeconds: 4 * 60 * 60 },
});
```

### `repos`

Repositories the factory acts on, keyed by `owner/name`. Webhooks from any other repository are ignored, even if the App is installed there. One deployment serves every repository listed, as long as the App is installed on it.

| Key | Required | Meaning |
|---|---|---|
| `baseBranch` | Yes | Branch that specs are implemented against, that snapshots are built from, and whose pushes trigger `refresh-snapshot` |
| `install` | No | Shell command that installs dependencies in the sandbox, run as the unprivileged `factory` user after credentials are scrubbed. It must leave tracked files unchanged (`npm ci`, not `npm install`). Omit it when nothing needs installing |
| `verify` | Yes | Commands that must all pass before Spec-to-PR opens a PR, and that PR Reviewer runs and reports. An empty list skips verification |

When you change `install`, push to the base branch afterwards (or wait for the next push). Until then, a restored sandbox notices the changed command and reinstalls on every run.

### Everything else

| Key | Default | Meaning |
|---|---|---|
| `labels.triage` | `factory:triage` | Starts Triage on an issue. Comments on an issue with this label also start Triage |
| `labels.specApproved` | `factory:spec-approved` | Starts Spec-to-PR on an issue that has a spec |
| `labels.prReview` | `factory:pr-review` | Starts PR Reviewer on an open PR |
| `commandPrefix` | `/factory` | Prefix for comment commands. `<prefix> cancel` on the first line of a comment cancels the run in progress |
| `minimumPermission` | `write` | The repository permission (`triage`, `write`, `maintain`, or `admin`) the person who applies a label or comments needs. Checked live on every run |
| `models.small` | `anthropic/claude-haiku-4-5` | Model for the `small` tier, as `provider/model` from Pi's model registry. No agent uses this tier yet |
| `models.medium` | `anthropic/claude-sonnet-5` | Triage, self-review, the four specialist reviewers, and the synthesizer |
| `models.large` | `anthropic/claude-opus-5` | The spec writer and the implementer |
| `limits.perRunUsd` | `20` | Dollar budget for one run, across every agent it calls, failed calls included |
| `limits.repairRounds` | `2` | Implementer runs allowed after a failed verify in Spec-to-PR |
| `limits.maxChangedFiles` | `200` | Publishing refuses a change with more files than this |
| `limits.maxFileBytes` | `1000000` | Publishing refuses any changed file larger than this |
| `sandbox.timeoutSeconds` | `14400` (4 hours) | Render terminates a run's sandbox after this, even if the task that opened it crashed. Keep it at least as long as the longest phase task (Spec-to-PR's is 4 hours) |

`setup:github` creates the three trigger labels and `factory:working`, the label a run puts on its issue or PR while it's active. If you rename a label, rerun `npm run setup:github`.

To use another model provider, set its models in `models`, add the provider's key variable (see `app/runner/keys.ts`) to `factory-workflows` in `render.yaml` with `sync: false`, and set it in the Dashboard. `npm run doctor` checks that every tier's key is set. The runner's self-test covers the `anthropic`, `openai`, and `google` providers.

## Environment variables

Each service reads only its own variables. `render.yaml` declares them, and `.env.example` lists them for local development, where both services share one `.env` file.

### `factory-gateway`

| Variable | Required | Set by | Meaning |
|---|---|---|---|
| `DATABASE_URL` | No | Blueprint (`fromDatabase`) | Postgres connection string. Without it, no events are recorded and the trace UI reports the database as unavailable |
| `GITHUB_WEBHOOK_SECRET` | Yes | You (`sync: false`), from `setup:app` | The App's webhook secret. The gateway refuses to start without it |
| `FACTORY_ADMIN_TOKEN` | No | Blueprint (`generateValue`) | Signs in to the trace UI and authenticates `/api`. Without it, `/ui` and `/api` answer 503 |
| `RENDER_API_KEY` | Yes | You (`sync: false`) | Starts Workflows tasks |
| `RENDER_WORKFLOW_SLUG` | Yes | Blueprint (`fromService`) | Slug of `factory-workflows`. Tasks start as `<slug>/<task>` |
| `PORT` | No | Render | Port to listen on, on `0.0.0.0`. Defaults to 3000 |

### `factory-workflows`

| Variable | Required | Set by | Meaning |
|---|---|---|---|
| `DATABASE_URL` | No | Blueprint (`fromDatabase`) | Postgres connection string, for events |
| `RENDER_API_KEY` | Yes | You (`sync: false`) | Creates sandboxes and snapshots, and reads and cancels task runs for latest-wins and `cancel` |
| `RENDER_WORKSPACE_ID` | No | You (`sync: false`) | The workspace (`tea-…`) that sandboxes run in. When unset, it's resolved from the API key, which works only if the key can see exactly one workspace |
| `GITHUB_APP_ID` | Yes | You (`sync: false`), from `setup:app` | The App's ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | You (`sync: false`), from `setup:app` | The App's private key: a PEM (real or `\n`-escaped newlines) or a base64-encoded PEM, which is what `setup:app` prints. Installation tokens are minted per webhook, for the installation that sent it |
| `ANTHROPIC_API_KEY` | Yes | You (`sync: false`) | Model key for the default `anthropic/…` models. Use a spend-capped key: it enters sandboxes during agent runs |
| `GITHUB_API_URL` | No | Not in `render.yaml` | GitHub API base URL, for GitHub Enterprise Server. Defaults to `https://api.github.com` |
| `RENDER_API_MIN_INTERVAL_MS` | No | Not in `render.yaml` | Minimum gap between Sandbox API calls from one process. Defaults to 1000 |

Variables marked "Not in `render.yaml`" are optional tuning. Add them to the service by hand if you need them.

### Scripts

The scripts run locally with `.env` loaded if present, or in a service's Render Shell with that service's environment.

| Script | Reads |
|---|---|
| `npm run setup:app` | `GITHUB_API_URL` (optional). Writes `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` to `.env` with `--write-env` |
| `npm run setup:github` | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` (or `--webhook-secret`), `GITHUB_API_URL` (optional) |
| `npm run doctor` | Every variable above for the selected services, plus `RENDER_EXTERNAL_URL` (set by Render) to check that the webhook points at this gateway |
| `npm run db:migrate` | `DATABASE_URL` |
| `npm run eval` | For live runs: the Workflows variables, plus `FACTORY_EVAL_INSTALLATION_ID` (or `--installation`). `CI` makes `--validate` the default |

`NO_COLOR` turns off colored script output.
