# software-factory

software-factory is an extensible template for building GitHub-native coding agent
workflows on Render. It includes a complete issue-to-PR workflow that you can
run, change, or use as the foundation for your own automations.

Start by [forking this repository](https://github.com/render-examples/software-factory/fork).
Deploy from your fork: its `factory.config.ts` defines the repositories the
factory may access.

The recommended setup is agent-guided:

1. Check the prerequisites in the [Quickstart](docs/quickstart.md).
2. Ask a coding agent to follow the [Setup runbook](docs/runbooks/setup.md).
3. Complete the GitHub, secret, and paid-resource checkpoints when the agent
   asks.

The runbook configures the fork before deployment, creates a GitHub App,
stores secrets in Render environment groups, deploys the Render Blueprint,
connects the webhook, verifies both services, and runs one Triage smoke test.

**What software-factory solves for you:**
1. Authenticating GitHub events and routing them to durable Render Workflows tasks.
2. Running agents and repository tools inside short-lived, isolated Render Sandboxes.
3. Handling overlapping runs, cancellation, cleanup, and idempotency.
4. Validating typed agent output and safely publishing proposed code to GitHub.
5. Providing deployment configuration, setup scripts, health checks, and structured telemetry.

**What software-factory leaves for you:**
1. The agents, prompts, and workflow logic for your use case.
2. Repository-specific install and verification commands.
3. The GitHub triggers, approval gates, and permissions your workflow needs.
4. Model selection, budgets, and evaluation strategy.
5. Channel integrations.
6. Persistent data store.

## Included workflow

- **Triage:** reads the issue, discussion, and repository. It asks questions,
  writes a specification, or declines the request.
- **Spec-to-PR:** implements the approved specification, runs your verification
  commands, and opens a draft pull request.
- **PR Reviewer:** runs verification and reviews security, correctness,
  performance, and tests. It posts a non-approving GitHub COMMENT review.

GitHub holds the discussion, labels, specifications, pull requests, and
reviews. Render Workflows runs the tasks. Sandboxes contain the checkout,
agent loop, and model-directed tools. The included workflow never approves or
merges code.

The three labels above keep each transition human-gated. Apply
`factory:autopilot` to an issue to grant upfront approval for the same stages:
Triage drafts the spec, Spec-to-PR opens a draft pull request, and PR Reviewer
posts its review as child tasks in one Render Workflow. If Triage asks
questions, the workflow stops and continues when a person replies.

## Extend the template

The built-in agents and tasks are examples of the template's extension model:

- Add or replace an agent with a Markdown prompt, a model tier, a bounded Zod
  output schema, and the minimum tools it needs.
- Define a GitHub task for work attached to an issue or pull request.
- Add a plain Workflows task for maintenance or other work without a GitHub
  claim.
- Route new GitHub events, labels, or commands through the authenticated
  gateway.
- Change repositories, verification commands, models, permissions, and limits
  in `factory.config.ts`.

The Sandbox runner, claim lifecycle, GitHub client, formatting helpers, and
publishing boundary are reusable building blocks. Start with the
[extension runbook](docs/runbooks/extend.md), which covers the required files,
tests, authority rules, deploys, and snapshot refreshes.

## Security

- Model-directed code and tools run inside Sandboxes, not on the Workflow task.
- GitHub write credentials never enter a Sandbox.
- Clone and fetch credentials are read-only and removed before repository code
  or agents run.
- Models propose typed results and file trees. Code in the Workflows service
  chooses every repository, ref, branch, issue, pull request, and write target.
- Publishing rejects unsafe paths and modes, workflow files, symlinks,
  submodules, oversized changes, and branches with human commits.
- GitHub must reproduce the candidate tree SHA before the factory publishes
  it.

Sandboxes use allow-all egress, and the model key exists in runner memory
during a call. Read the [trust boundaries](docs/architecture.md#trust-boundaries)
and [residual risks](docs/architecture.md#residual-risks) before using private
code or untrusted pull requests.

## Limits

- Verification runs shell commands. Browser testing is not included.
- Turn limits and timeouts bound execution, but the factory has no hard dollar
  budget.
- Anyone with `minimumPermission` can start model spend.
- PR Reviewer runs configured commands against the labeled pull request.
- Sandbox API calls count against the Render workspace's request limit.

## Documentation

- [Quickstart](docs/quickstart.md) — what you need and how to start setup.
- [Setup runbook](docs/runbooks/setup.md) — agent protocol for the first
  deployment.
- [Configuration](docs/configuration.md) — settings, logs, run control,
  deployment checks, and snapshots.
- [Architecture](docs/architecture.md) — execution, state, coordination, and
  trust boundaries.
- [Extension runbook](docs/runbooks/extend.md) — add agents, Workflows tasks,
  and GitHub triggers.
- [Contributing](CONTRIBUTING.md) — local development and verification.

## License

MIT. See [LICENSE](LICENSE).
