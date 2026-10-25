# software-factory

software-factory is an extensible template for building GitHub-native coding
workflows on Render. It includes a complete issue-to-PR workflow that you can
run as-is, change one agent at a time, or use as the foundation for different
automations.

The template provides the infrastructure common to agent workflows:

- a signed-webhook gateway;
- durable Render Workflows tasks with cancellation and run ownership;
- short-lived Render Sandboxes for repository code and model-directed tools;
- typed agent inputs and outputs;
- GitHub App authentication and artifact markers; and
- validated publishing that keeps write credentials outside Sandboxes.

## Included workflow

- **Triage** reads the issue, discussion, and repository. It asks questions,
  writes a specification, or declines the request.
- **Spec-to-PR** implements the approved specification, runs your verification
  commands, and opens a draft pull request.
- **PR Reviewer** runs verification and reviews security, correctness,
  performance, and tests. It posts a non-approving GitHub COMMENT review.

GitHub holds the discussion, labels, specifications, pull requests, and
reviews. Render Workflows runs the tasks. Sandboxes contain the checkout,
agent loop, and model-directed tools. The included workflow never approves or
merges code.

## Extend the template

The built-in agents and tasks are examples of the template's extension model:

- Add or replace an agent with a Markdown prompt, a model tier, a bounded Zod
  output schema, and the minimum tools it needs.
- Add a claiming task for work attached to an issue or pull request.
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

## Set up

Start by
[forking this repository](https://github.com/render-examples/software-factory/fork).
Deploy from your fork: its `factory.config.ts` defines the repositories the
factory may access.

The recommended setup is agent-guided:

1. Check the prerequisites in the [Quickstart](docs/quickstart.md).
2. Ask a coding agent to follow the
   [Setup runbook](docs/runbooks/setup.md).
3. Complete the GitHub, secret, and paid-resource checkpoints when the agent
   asks.

The runbook configures the fork before deployment, creates a GitHub App,
deploys the Render Blueprint, connects the webhook, verifies both services,
and runs one Triage smoke test.

## Security

- Model-directed code and tools run inside Sandboxes, not on the Workflows
  host.
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

- Main tasks do not chain. Labels, comments, commands, and base-branch pushes
  start work through the gateway.
- Verification runs shell commands; browser testing is not built in.
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
