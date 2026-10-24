# Software Factory

Software Factory turns a labeled GitHub issue into an approved specification,
a verified draft pull request, and an automated code review. People approve
every transition; the factory never approves or merges changes.

It runs in your Render workspace using one web service, one Workflows
service, Postgres, and Render Sandboxes.

**Start by [forking this repository](https://github.com/render-examples/software-factory/fork).**
The factory must deploy from your fork because `factory.config.ts` defines
which repositories it may access.

## Workflow

```text
issue --factory:triage--> specification
specification --factory:spec-approved--> verified draft PR
pull request --factory:pr-review--> COMMENT review
```

- **Triage** reads the issue, discussion, and code, then asks focused
  questions, writes a specification, or declines.
- **Spec-to-PR** implements the exact approved specification, runs configured
  verification, repairs bounded failures, and opens a draft pull request.
- **PR Reviewer** runs verification and reviews security, correctness,
  performance, and tests.

GitHub remains where people discuss and approve work. Render Workflows owns
durable execution. Postgres orders competing runs. Sandboxes contain
model-directed tools and repository code.

## Deploy

You need a Render workspace with Sandboxes access in Oregon, a Render API
key, a dedicated spend-capped model API key, GitHub repository admin access,
and the Node.js version in `.node-version`.

For the fastest path, ask a coding agent to follow
[`docs/runbooks/setup.md`](docs/runbooks/setup.md). It separates work the
agent can perform from GitHub, secret, and paid-resource checkpoints that
require you.

1. Fork the repository and configure one target in `factory.config.ts`.
2. Run `npm ci` and `npm run setup:app -- --write-env`.
3. Install the generated GitHub App on the target repository.
4. Create a Render Blueprint from your fork and provide its secret values.
5. Run `npm run setup:github -- --gateway-url https://<gateway>.onrender.com`.
6. Activate the webhook in GitHub App settings.
7. Run `npm run doctor`, then apply `factory:triage` to an issue.

See the [Quickstart](docs/quickstart.md) for the short human guide or the
[Setup runbook](docs/runbooks/setup.md) for the complete agent protocol.

## Security model

- Agents and model-directed tools run only inside short-lived Sandboxes.
- No GitHub write credentials enter the Sandbox.
- Clone and fetch use temporary read-only credentials that are removed before
  repository code or agents run.
- Models cannot choose repositories, branches, issue numbers, pull requests,
  or GitHub write targets.
- Trusted Workflows code validates candidate changes and requires GitHub to
  reproduce their tree SHA before publishing.
- Publishing rejects unsafe paths, workflow files, symlinks, submodules,
  oversized changes, and branches containing human commits.

Sandboxes use allow-all egress, and a model key exists in runner memory during
a call. Treat repository and pull request content as untrusted, and use a
dedicated Render workspace and provider-capped key when isolation matters.
Read the [trust boundaries and residual risks](docs/architecture.md#trust-boundaries)
before deploying against private code.

## Limits

- Stages never chain automatically.
- Verification is command-based; browser testing is not built in.
- Turn limits and timeouts bound agents, but the factory has no hard dollar
  budget.
- Anyone with the configured GitHub permission can start model spend.
- PR Reviewer executes configured verification against the labeled PR code.
- Sandbox API calls share the Render workspace's rate limit.

## Documentation

- [Setup runbook](docs/runbooks/setup.md) — agent-guided deployment with verified checkpoints.
- [Quickstart](docs/quickstart.md) — deploy and complete the first run.
- [Configuration](docs/configuration.md) — repositories, labels, models, and limits.
- [Operations](docs/operations.md) — logs, cancellation, snapshots, and failures.
- [Architecture](docs/architecture.md) — state ownership and trust boundaries.
- [Contributing](CONTRIBUTING.md) — local development, agents, stages, and triggers.
- [Design notes](docs/design-notes.md) — reusable patterns behind the system.

## License

MIT. See [LICENSE](LICENSE).
