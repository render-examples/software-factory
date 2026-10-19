# Getting started

This guide deploys the factory to Render, then sets up local development. The README has the short version.

## Before you start

- A Render workspace with Sandboxes early access. Everything deploys in Oregon.
- A Render API key for that workspace, from **Account Settings > API Keys**.
- An Anthropic API key. Make a dedicated one with a spend limit: it enters sandboxes during agent runs.
- Admin access to the GitHub repositories the factory will act on (to install the App), and to the organization if you create the App there.
- Node.js 22.19 or later and npm.

## Deploy

### 1. Fork and configure

Fork this repository. In `factory.config.ts`, replace the example under `repos` with your repositories:

```ts
repos: {
	"acme/web": { baseBranch: "main", install: "npm ci", verify: ["npm run build", "npm test"] },
	"acme/api": { baseBranch: "main", install: "go mod download", verify: ["go test ./..."] },
},
```

`install` runs in the sandbox as an unprivileged user and must not change tracked files. `verify` runs before Spec-to-PR opens a PR and during PR review. [configuration.md](configuration.md) covers every key. Commit and push.

### 2. Create the GitHub App

```bash
npm ci
npm run setup:app -- --write-env              # on your account
npm run setup:app -- --org acme --write-env   # or in an organization
```

The script serves a page on `127.0.0.1`. Open it and click **Create on GitHub**: GitHub creates the App from a manifest that requests Contents, Issues, and Pull requests (write) and Metadata (read), and subscribes to issues, issue comments, pull requests, and pushes. The App's webhook starts inactive at a placeholder URL, because the gateway doesn't exist yet.

When GitHub redirects back, the script prints `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (base64-encoded so it fits on one line), and a freshly generated `GITHUB_WEBHOOK_SECRET`. GitHub shows the private key only once. With `--write-env` the script also writes all three to `.env`, which the later scripts read; without it, copy them now.

### 3. Install the App

Open the installation link the script prints and install the App on every repository in `factory.config.ts`. The factory mints a token for whichever installation sent each webhook, so one App can serve repositories across accounts.

### 4. Deploy the Blueprint

In the Render Dashboard, create a Blueprint from your fork (**New > Blueprint**). Select your fork, not `render-examples/software-factory`: the committed `factory.config.ts` is application config, so deploying upstream would use its example repository. The Blueprint creates `factory-db`, `factory-gateway`, and `factory-workflows` in Oregon. Fill in the form:

| Service | Variable | Value |
|---|---|---|
| `factory-gateway` | `GITHUB_WEBHOOK_SECRET` | From step 2 |
| `factory-gateway` | `RENDER_API_KEY` | Your Render API key |
| `factory-workflows` | `RENDER_API_KEY` | The same key |
| `factory-workflows` | `RENDER_WORKSPACE_ID` | Your workspace ID (`tea-…`). Optional when the key sees only one workspace |
| `factory-workflows` | `GITHUB_APP_ID` | From step 2 |
| `factory-workflows` | `GITHUB_APP_PRIVATE_KEY` | From step 2 |
| `factory-workflows` | `ANTHROPIC_API_KEY` | Your spend-capped Anthropic key |

The Blueprint fills in the rest: `DATABASE_URL` from `factory-db`, `RENDER_WORKFLOW_SLUG` from `factory-workflows`, and a generated `FACTORY_ADMIN_TOKEN`. The gateway runs `npm run db:migrate` before each deploy. Afterwards, check in the Dashboard that every `sync: false` value is set; empty ones are easy to miss.

### 5. Connect the webhook and create the labels

Once the gateway is live:

```bash
npm run setup:github -- --gateway-url https://<gateway>.onrender.com
```

It sets the App's webhook URL to `https://<gateway>.onrender.com/webhooks/github` with the webhook secret, and creates `factory:triage`, `factory:spec-approved`, `factory:pr-review`, and `factory:working` on each repository. It's idempotent: rerun it after you add a repository or rename a label. Without `.env`, pass `--webhook-secret <GITHUB_WEBHOOK_SECRET>` and set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in the environment.

### 6. Activate the webhook

GitHub's API can't turn an App webhook on. Open the App's settings page (the script prints the link), check **Webhook > Active**, and click **Save changes**. Leave the URL and secret as they are.

### 7. Check the deployment

```bash
npm run doctor
```

`doctor` is read-only and never prints a secret. It checks:

- the environment each service needs, as `render.yaml` declares it;
- a model key for every tier in `models`;
- the App: credentials, permissions, events, webhook URL and content type, and recent deliveries;
- each repository: the App's installation, a token, and the labels;
- Postgres: reachability, the `events` table, and applied migrations;
- the Workflows service: every task the gateway starts is registered.

Locally it checks `.env`. To check what's actually deployed, run it in each service's Render Shell: `npm run doctor -- --service gateway` on the gateway and `npm run doctor -- --service workflows` on the Workflows service. It exits 1 if any check fails.

### 8. Try it

Open an issue in one of your repositories and add `factory:triage`. A status comment appears within a few seconds. The first run on a repository builds its snapshot inline, which takes a few minutes; after that, every push to the base branch rebuilds it in the background, and runs start in seconds.

To see what happened, open `https://<gateway>.onrender.com/ui` and sign in with `FACTORY_ADMIN_TOKEN` from the gateway's environment in the Dashboard. Each task run is also in the Dashboard under `factory-workflows`.

## Local development

You need Docker (for Postgres) and the [Render CLI](https://render.com/docs/cli) 2.29 or later (for `render workflows dev`). Local runs still use real Sandboxes, the real GitHub App, and a real model, so use a separate test repository and, ideally, a separate App.

```bash
npm ci
cp .env.example .env    # then fill it in; setup:app --write-env fills the GitHub values
```

Run each in its own terminal:

```bash
npm run dev:postgres                              # docker compose: Postgres on localhost:55432
npm run db:migrate                                # creates the events table
npm run dev:workflows                             # render workflows dev: the task server on localhost:8120
RENDER_USE_LOCAL_DEV=true npm run dev:gateway     # the gateway on localhost:3000, starting tasks on the local task server
```

`RENDER_USE_LOCAL_DEV=true` tells the Render SDK in the gateway to send `startTask` to the local task server instead of Render. The Workflows process always sends Sandbox calls to Render, so sandboxes are real either way.

GitHub needs a public HTTPS URL to deliver webhooks. Expose the gateway with a tunnel, such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, then point the App at it:

```bash
npm run setup:github -- --gateway-url https://<your-tunnel-host>
```

An App has one webhook URL, which is why a separate App for development helps: pointing the production App at your tunnel takes production offline.

You can also start a task without GitHub: `render workflows tasks list --local` lists the local tasks, and `render workflows tasks runs start --local --task <task> --input='[{...}]'` starts one with the input the gateway would send (see `app/contracts/tasks.ts`).

## Checks

```bash
npm run check    # Biome lint, tsc, and every Vitest test
```

Tests never call a live service: GitHub, Render, Postgres, and models are faked. For one file, run `npx vitest run tests/gateway.test.ts`. Biome uses tabs and a line width of 150 (`biome.json`).

When `render.yaml` changes, validate it with `render blueprints validate render.yaml`. CI runs it when the repository has a `RENDER_API_KEY` secret and a `RENDER_WORKSPACE_ID` variable. CI also runs `shellcheck` on `sandbox-runtime/` and `npm audit --omit=dev --audit-level=high`.

## Evals

Eval cases in `evals/cases/*.json` describe an issue and what Triage should do with it: the decision, a cap on questions, terms the spec must mention, strings no output may contain (the prompt-injection cases), and a cost ceiling.

```bash
npm run eval -- --validate                                   # check the case files; no services, no cost
npm run eval -- --installation 12345                         # run every case live
npm run eval -- --installation 12345 --case underspecified-search --budget 2
```

`--validate` is what CI runs, and it's the default when `CI` is set. A live run needs the Workflows service's environment (the Render API key, the GitHub App, a model key) and the App's installation ID for the target repository (`--installation` or `FACTORY_EVAL_INSTALLATION_ID`). It opens a sandbox from that repository's snapshot, runs the real triage and spec-writer agents on each case, and grades what they produce. With `DATABASE_URL` set, each run records a trace you can open in the trace UI. Live runs cost real money; `--budget` sets each case's soft stop threshold, which reported usage can exceed. [agents.md](agents.md#evals) explains how to add a case.
