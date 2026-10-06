# Security

1. The gateway verifies the webhook signature before parsing. It holds no GitHub or Render credentials.
2. Every run re-checks the actor's live repo permission.
3. GitHub access uses a GitHub App with short-lived tokens.
4. Sandboxes only see a read-only token, and only during clone or fetch.
5. Model credentials never enter a sandbox.
6. Agents only get the tools they declare. Built-in runner tools are disabled.
7. Every tool call is policy-checked for destructive commands, secret exfiltration, and paths outside the checkout.
8. Models never choose sandbox IDs, branches, GitHub targets, or task names.
9. GitHub writes are idempotent.
10. Secrets are redacted from everything posted to GitHub.
11. Each run has a dollar budget.
12. Automation stops at a draft PR and a comment review. It never approves or merges.

The full invariants list is in [AGENTS.md](../AGENTS.md#invariants).
