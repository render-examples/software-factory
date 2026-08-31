# render-factory

A small, self-hosted software factory built from Render Web Services,
Workflows, Sandboxes, and Key Value.

It intentionally operates on one repository. A maintainer applies one label,
the factory implements the issue in an isolated sandbox, three reviewers
inspect the staged diff in parallel, and the workflow opens a reviewed draft
pull request. A person decides when it is ready and merges it.

## How it works

1. Configure `FACTORY_REPO=owner/repo`.
2. A maintainer listed in `FACTORY_GITHUB_ACTORS` applies the `factory` label.
3. The gateway verifies the GitHub signature, repository, actor, action, and
   label, atomically claims the delivery and issue, then dispatches the issue
   number with GitHub's delivery ID.
4. The workflow fetches the issue and comments directly from GitHub.
5. Triage either asks for clarification or starts an isolated sandbox.
6. The analyst researches the checkout and prepares a plan.
7. The implementer edits the checkout and runs the repository's checks.
8. Security, correctness, and test reviewers inspect the staged diff in
   parallel; a judge synthesizes their result. One requested revision runs
   through implementation and review again.
9. Only an approved revision is pushed, its remote SHA is verified, and the
   workflow opens a draft pull request.

Every stage is checkpointed in Key Value. Automatic task retries reconnect to
the same sandbox and deterministic branch instead of starting duplicate work.

If clarification or a retry is needed, a maintainer reapplies the label.
Issue comments never trigger the factory.

## Architecture

```text
GitHub issues.labeled
  │
  ▼
Gateway web service
  ├─ verifies HMAC
  ├─ matches FACTORY_REPO + FACTORY_LABEL
  ├─ checks FACTORY_GITHUB_ACTORS
  ├─ deduplicates delivery + leases issue
  └─ dispatches { issueNumber, attemptId }
  │
  ▼
Render Workflows
  ├─ triage
  ├─ analyst ───────────────┐
  ├─ implementer            │ one Render Sandbox
  ├─ security ┐             │
  ├─ correctness ├ parallel │
  ├─ tests ────┘            │
  ├─ judge                  │
  └─ draft pull request ◀───┘

Render Key Value
  ├─ delivery deduplication and issue leases
  ├─ replay checkpoints for every pipeline stage
  └─ oversized workflow handoff artifacts
```

The gateway runs no models and holds no repository credential. GitHub writes
are owned by workflow code, not model-callable tools. Agents receive only the
sandbox operations needed by their station. `GET /health` reports process
liveness; `GET /ready` checks Key Value and is the deployed health check.

## Quick start

```bash
git clone https://github.com/<you>/render-factory.git
cd render-factory
npm install
cp .env.example .env

npm run dev:redis
npm run dev:gateway
npm run dev:workflows
```

Configure a GitHub webhook for `issues` events at:

```text
https://<gateway>/channels/github
```

Use a fine-grained GitHub token scoped only to `FACTORY_REPO`, with the
minimum Contents, Issues, and Pull Requests permissions needed to create a
feature branch, comment, and open a draft PR. Protect the default branch.

## Configuration

| Variable | Service | Purpose |
|---|---|---|
| `FACTORY_REPO` | Both | The only repository the factory can operate on |
| `FACTORY_LABEL` | Both | Intake label; defaults to `factory` |
| `FACTORY_GITHUB_ACTORS` | Gateway | Comma-separated maintainer logins allowed to apply the label |
| `GITHUB_WEBHOOK_SECRET` | Gateway | GitHub webhook HMAC secret |
| `RENDER_WORKFLOW_SLUG` | Gateway | Deployed Workflows service slug |
| `ANTHROPIC_API_KEY` | Workflows | Claude Agent SDK credential |
| `GITHUB_TOKEN` | Workflows | Fine-grained token scoped to `FACTORY_REPO` |
| `RENDER_API_KEY` | Workflows | Render Sandbox API credential |
| `RENDER_WORKSPACE_ID` | Workflows | Workspace containing the sandboxes |
| `REDIS_URL` | Both | Internal Key Value connection string for intake leases and workflow checkpoints |

`FACTORY_LABEL` has a safe default. `REDIS_URL` is wired automatically for
the gateway Blueprint and points to local Docker in `.env.example`.

After filling `.env` and starting local Key Value, validate configuration and
external access before creating a service:

```bash
npm run doctor
```

## Deploy to Render

1. Fork this repository.
2. Create a Blueprint from `render.yaml`. It provisions:
   - `render-factory-gateway`
   - `render-factory-kv`, with external access disabled
3. Set the gateway variables shown above.
4. Create a Render Workflows service, connect this repository, and use:

   ```bash
   npx tsx app/src/workflows.ts
   ```

5. Set the Workflows variables, using the Key Value internal URL.
6. Point the GitHub `issues` webhook at `/channels/github`.

Render Workflows cannot currently be provisioned by Blueprints. The doctor
command validates everything it can locally; the remaining manual check is
that the Dashboard Workflow slug matches `RENDER_WORKFLOW_SLUG`.

## Safety boundaries

- One validated repository, fixed at deployment time.
- One maintainer-applied intake label.
- Only `issues.labeled` starts work.
- GitHub delivery deduplication, one active lease per issue, and replay-safe
  stage checkpoints.
- No public chat API or Slack control plane.
- No model-callable GitHub, Render, deploy, environment, or merge tools.
- Built-in Claude tools are explicitly restricted and unattended permissions
  fail closed.
- Repository execution stays in a Render Sandbox.
- Git credentials are supplied only around clone and push and are not stored
  in the Git remote.
- Generated branches use the `factory/` prefix.
- One internal revision is allowed; unresolved findings stop without a PR.
- Automation ends at an approved draft PR; readiness and merge remain human
  decisions.

## Customize

Agents are plain configuration:

```ts
export const analyst = Agent({
  id: "analyst",
  model: "medium",
  tools: [
    "sandbox__read_file",
    "sandbox__list_dir",
    "sandbox__search",
  ],
  prompt: md`
    Explore the configured repository read-only and produce a grounded plan.
  `,
});
```

The pipeline is in `app/workflows/spec-to-pr.ts`; agent definitions are in
`app/agents/index.ts`.

## Verification

```bash
npm run typecheck
npm test
npm run lint
render blueprints validate
```

## License

MIT
