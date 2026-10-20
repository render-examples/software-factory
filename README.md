# software-factory

A self-hosted factory that turns a labeled GitHub issue into a reviewed spec,
a verified draft pull request, and a COMMENT review. It runs in your Render
workspace with one web service, one Workflows service, Postgres, and a fresh
Render Sandbox for each phase.

The factory is deliberately gated by people. Label an issue to triage it,
approve the resulting spec with a second label, and label the pull request
when you want a review. The factory never approves, marks ready, or merges.

**Start by [forking this repository](https://github.com/render-examples/software-factory/fork).**
The Blueprint must deploy from your fork because
[`factory.config.ts`](factory.config.ts) names the repositories the factory
can act on.

## Why it matters

Turning an issue into a safe change involves more than generating code.
Someone has to clarify the request, agree on acceptance criteria, work in the
right repository and branch, run the repository's checks, inspect the diff,
and leave an auditable trail.

The factory performs that repeatable work without removing the decisions that
belong to people:

- **Triage** reads the issue, discussion, and code, then asks focused
  questions, writes a spec, or declines.
- **Spec-to-PR** implements only an explicitly approved spec, runs configured
  verification, self-reviews the result, and opens a draft PR.
- **PR Reviewer** runs verification and combines security, correctness,
  performance, and test reviews into one COMMENT review.

GitHub remains the place where people converse and approve transitions.
Render Workflows owns durable execution. Postgres orders competing runs on the
same issue or PR. Sandboxes contain model-directed tools and repository code.

### What it demonstrates on Render

- **Workflows:** webhook events start durable phase tasks directly; there is no
  custom queue, dispatcher, heartbeat loop, or cron.
- **Sandboxes:** every phase restores a per-repository snapshot with
  dependencies installed, fetches the requested ref, and terminates in
  `finally`.
- **Blueprints:** [`render.yaml`](render.yaml) creates the gateway, Workflows
  service, database, environment wiring, health check, and pre-deploy
  migration.
- **Postgres:** one append-only event table provides strict run fencing where
  correctness needs it and best-effort traces everywhere else.

## How a change flows

1. A repository collaborator applies `factory:triage`. The gateway verifies
   GitHub's webhook signature and starts the `triage` task.
2. The task checks the actor's current permission, claims the issue in
   Postgres, restores a Sandbox, and runs Triage. The factory posts questions,
   a spec, or a decline. Replies on an issue still carrying the label start a
   new round.
3. A person reviews the spec and applies `factory:spec-approved`.
   Spec-to-PR uses the exact spec that existed when the label was applied,
   implements it, runs the configured checks, and opens a draft PR on
   `factory/issue-<n>`.
4. A person applies `factory:pr-review` to any open PR. Four specialist agents
   inspect the labeled commit and a synthesizer posts one COMMENT review.
5. Each base-branch push starts `refresh-snapshot`, preparing the next
   dependency-installed snapshot. The first run builds one inline if needed.

Every factory-written comment carries a hidden marker, so a redelivered
webhook updates existing work instead of duplicating it. A status comment and
the `factory:working` label show which run currently owns an issue or PR.

## Security

- No GitHub write credential enters a Sandbox. The Workflows service checks
  Sandbox output and publishes through GitHub's Git Data API.
- Repository tokens are read-only, exist only during clone or fetch, and are
  scrubbed before repository code or agents run.
- Agents with tools run only in Sandboxes as an unprivileged user. Agents
  without tools run in the Workflows task and receive no tools.
- Models do not choose repositories, branches, issue numbers, PR numbers, or
  GitHub write targets.
- Publishing rejects workflow files, symlinks, submodules, unsafe paths,
  oversized changes, and any tree GitHub does not reproduce exactly.

Sandboxes use allow-all egress because dependency installation and Git fetches
need network access. Treat repository content and pull requests as untrusted,
use a dedicated spend-capped model key, and read the architecture guide's
[trust boundaries](docs/2_ARCHITECTURE.md#trust-boundaries) before deploying
against private code.

## Get running

You need a Render workspace with Sandboxes access in Oregon, a Render API key,
a dedicated model API key (Anthropic by default), GitHub repository admin
access, and Node.js 24 (the version pinned in `.node-version`; the package
declares 22.19 as its minimum).

1. Fork this repository. Configure each target repository's base branch,
   install command, and verify commands in `factory.config.ts`. Commit and
   push.
2. Run `npm ci` and `npm run setup:app -- --write-env` to create the GitHub
   App. Install it on every configured repository.
3. Create a Render Blueprint from your fork. Enter the App credentials, Render
   API key, and model key.
4. When `factory-gateway` is live, run
   `npm run setup:github -- --gateway-url https://<gateway>.onrender.com`.
   Then activate the webhook in the GitHub App settings.
5. Run `npm run doctor`, apply `factory:triage` to an issue, and follow the
   status comment. The first run for a repository takes a few minutes while
   its snapshot is built.

The [Quickstart](docs/0_QUICKSTART.md) covers deployment, first use, local
development, evals, and operations in detail.

## Limits

- Phases never chain automatically, and the factory never approves or merges.
- Verification is command-based; the template has no browser-testing phase.
- `limits.perRunUsd` is a soft threshold because providers report cost after
  a response. A provider-enforced spend limit is the hard backstop.
- Sandboxes have allow-all egress and share Render's workspace-level Sandbox
  API rate limit.
- Anyone with `minimumPermission` on a configured repository can start model
  spend, and PR Reviewer executes that PR's code through your verify commands.

## Learn more

- [docs/0_QUICKSTART.md](docs/0_QUICKSTART.md): deploy, use, develop, test,
  evaluate, and operate the factory.
- [docs/1_EXTENSION.md](docs/1_EXTENSION.md): configure repositories and
  models, change agents, add phases, and integrate another trigger.
- [docs/2_ARCHITECTURE.md](docs/2_ARCHITECTURE.md): repository layout, core
  execution paths, interfaces, state, publishing, and trust boundaries.
- [docs/3_TAKEAWAYS.md](docs/3_TAKEAWAYS.md): reusable patterns for
  human-gated agents, Workflows, Sandboxes, idempotency, and security.
- [AGENTS.md](AGENTS.md): instructions for coding agents working on this
  repository.

## License

MIT. See [LICENSE](LICENSE).
