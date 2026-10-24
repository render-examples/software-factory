# Design notes

These are the reusable ideas behind Software Factory. They are explanatory,
not required for deployment or operation.

## Let existing systems own their state

Render Workflows owns task execution. GitHub owns collaboration artifacts,
including the status comment that says which run currently works on an issue
or pull request. Postgres only records telemetry, so the factory runs without
it. Every additional source of truth creates reconciliation work.

## Make approval an explicit transition

Each label authorizes one bounded task. Triage cannot start implementation,
and implementation cannot start review. Native GitHub actions make these
gates visible and auditable without a separate control plane.

## Design for overlapping execution

Webhook redelivery, relabels, and near-simultaneous comments make “exactly
once” execution unrealistic. The factory combines task-start idempotency, a
claim held in the status comment, and artifact markers that make effects
repeatable.

A new run stops the old one (Render kills a cancelled task run) and terminates
its Sandbox, then checks that it still holds the claim immediately before each
durable effect.

## Prepare expensive state, verify current state

Snapshots avoid reinstalling tools and dependencies for every task. A
restored Sandbox still fetches the requested ref, checks its manifest, and
reinstalls when lockfiles or configuration changed.

## Put tools next to code, away from authority

The agent loop runs in the Sandbox beside the checkout. The security boundary
is isolated tool placement, an unprivileged user, temporary read-only
credentials, bounded lifetime, and host-side acceptance—not a shell-command
filter.

## Separate proposal from authority

Agents return bounded typed values and candidate file trees. Trusted host code
reconstructs destinations, validates content against independent ground
truth, and performs writes.

## Bound work and classify failures

Turn limits, call timeouts, repair limits, task timeouts, and
provider-enforced spend caps create practical bounds. Expected work failures
produce useful GitHub messages; platform failures fail the Workflows task for
an operator.

## State residual risk plainly

Layered controls reduce authority; they do not make arbitrary code and model
execution perfectly safe. See
[Architecture](architecture.md#residual-risks) for this project's accepted
risks.
