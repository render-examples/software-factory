# Security

The factory runs model-driven agents on code and issue text that anyone with access to your repositories can write. The design keeps three things out of an agent's reach: GitHub write access, the decision about what gets written where, and the final say on merging. This page lists the invariants that hold that line, where each is enforced, and what remains exposed.

## Trust boundaries

| Component | Holds | Runs |
|---|---|---|
| `factory-gateway` | Webhook secret, admin token, Render API key, database URL | No models and no repository code. No GitHub credential |
| `factory-workflows` | GitHub App private key, Render API key, model key, database URL | Phase logic, publishing, agents without tools. No tools and no repository code |
| Sandbox | The repository checkout; a read-only GitHub token only during a clone or fetch; the model key only during an agent run | Agent tools, the repository's `install` and `verify` commands, all as the unprivileged `factory` user |

## Invariants

Changing any of these is a change to the security model, not a refactor.

| # | Invariant | Enforced in |
|---|---|---|
| 1 | The gateway verifies the webhook signature before parsing the body. | `app/gateway/index.ts` reads the body with a 256 KB cap (`body.ts`) and checks it with a constant-time HMAC comparison (`signature.ts`) before `JSON.parse`. Unauthenticated requests write no events. |
| 2 | Every run checks the triggering actor's live repository permission before doing anything. | `withPhase` (`app/phases/with-phase.ts`) and `cancel` (`app/workflows/cancel.ts`) call `checkPermission` (`app/phases/permission.ts`) against `minimumPermission`. The gateway also ignores deliveries from bot accounts. |
| 3 | Only workflow code writes to GitHub, and every write finds its marker before creating anything. | The gateway has no GitHub credential. Markers (`app/github/markers.ts`) are trusted only on comments and reviews the App's bot wrote. The status comment (`app/phases/status.ts`), spec and questions comments (`app/workflows/triage/`), review (`app/workflows/pr-review/post.ts`), and PR (`findOrCreatePull`) are all looked up first. |
| 4 | No write credential enters a sandbox. A read-only token is present only to clone or fetch. | Tokens for sandboxes are minted with `contents: read` (`readToken` in `app/sandbox/snapshot.ts`), staged as a file read by a credential helper (`sandbox-runtime/build/git-credential-staged.sh`), and removed by `scrub-credentials.sh`, which fails the build or the open if any copy remains. Publishing runs on the host (`app/publish/index.ts`). |
| 5 | Tools run only in sandboxes, never in a Workflows task. | `runAgent`'s types require a sandbox for an agent with tools and forbid one for an agent without, and it checks both at runtime (`app/agents/run.ts`). `tests/agents-catalog.test.ts` pins every agent's tools; only the synthesizer has none. |
| 6 | Models never choose sandbox IDs, branches, repositories, or GitHub targets. | The repository and installation come from the webhook; the branch is `factory/issue-<n>` (`app/workflows/spec-to-pr/branch.ts`); the issue, PR, and head SHA come from the task input. Agent output schemas (`app/contracts/`) have no such fields, and inline review comments are limited to lines in the PR's diff (`app/workflows/pr-review/diff-lines.ts`). |
| 7 | A PR opens only after GitHub's tree SHA equals the verified sandbox tree. | `publish` checks every blob SHA against its contents and the tree GitHub built against the sandbox's staged tree before moving the branch (`app/publish/index.ts`). |
| 8 | Automation ends at a draft PR and a COMMENT review. It never approves, requests changes, marks a PR ready, or merges. | The GitHub client's review call accepts only `event: "COMMENT"` and has no merge or ready-for-review call (`app/github/client.ts`). Spec-to-PR opens PRs with `draft: true`. The App has no Actions or administration permission, and publishing refuses changes under `.github/workflows/` (`app/publish/changes.ts`). |
| 9 | Spec-to-PR implements the spec as it stood when the approval label was applied. | `loadApprovedSpec` (`app/workflows/spec-to-pr/approval.ts`) compares the spec comment's last edit with the label's timeline event and refuses a spec edited afterwards. The spec marker's hash must match its content. |
| 10 | Every sandbox is created with a timeout and terminated in `finally`. | `openSandbox` passes `sandbox.timeoutSeconds` (`app/sandbox/sandbox.ts`); snapshot builders get one hour (`app/sandbox/snapshot.ts`). Each phase closes its sandbox in `finally`. |
| 11 | No workflow decision reads Postgres. | Only the trace UI (`app/gateway/ui/`) reads `events`. `emit()` never throws (`app/events/index.ts`), so a database outage can't change a run. |

## Inside the sandbox

Agents and repository code run as the unprivileged `factory` user (`sandbox-runtime/as-runner.sh`) from the checkout, with a minimal environment. The runner, scripts, and manifest under `/opt/factory/app` are root-owned and read-only. Every restored sandbox runs `verify.sh`, which checks the layout, the permissions, and that no credential survived, before any agent runs.

Agents without `edit` or `write` also get a read-only shell policy (`app/runner/tools.ts`) that rejects obviously mutating or networked commands. It's a usability guard so the model adapts quickly, not a security boundary: the sandbox is the boundary.

## The model key in the sandbox

An agent with tools runs inside the sandbox, so its model calls start there, and the model key has to be there too. Sending each tool call into the sandbox from the task instead would keep the key out, but it would collide with the Sandbox API's 100-requests-a-minute limit.

What limits the exposure:

- **One-time key file.** `runAgent` uploads the key to a fresh run directory for each agent run. The runner reads it and deletes it immediately (`takeCredentials` in `app/runner/keys.ts`), and `run-agent.sh` deletes it again on exit.
- **Scrubbed tool environment.** The runner removes every provider's key variables from its environment before any tool runs, and tool subprocesses get a minimal environment (`app/runner/tools.ts`). Secrets are redacted from the runner's event stream.
- **Non-dumpable runner.** The runner runs under an execute-only copy of node, which makes the process non-dumpable, so tool subprocesses running as the same user can't read its memory or environment through `/proc`. `verify.sh` proves this in every restored sandbox, and `openSandbox` refuses a sandbox where it can't.
- **A spend-capped key.** Use a dedicated key with a low spend limit, so a leaked key costs at most that limit. Rotate it if you suspect a leak.

When Sandboxes supports credential brokering, the runner could call the model through a proxy that adds the key outside the sandbox, and the key would never enter it.

## Residual risks

- **Allow-all egress.** Sandboxes can reach any host: installs and fetches need the network, and early access offers only allow-all or deny-all. A prompt-injected agent, or malicious code in the repository or a PR under review, can send anything it can read to the internet. That includes the checkout (your private code) and, during an agent run, the model key.
- **The key file before it's read.** The non-dumpable runner protects the key in memory, not the file in the moment between its upload and the runner deleting it. Code that ran as the `factory` user earlier in the same sandbox could leave a process behind to grab it: the repository's `install` or `verify` commands, a PR's own code (PR Reviewer runs `verify` on the PR head before its specialists), or an earlier agent's shell commands.
- **DNS.** Sandboxes resolve arbitrary names, so DNS is an exfiltration channel that a future egress allow-list wouldn't close.
- **Whoever can label can spend.** Anyone with `minimumPermission` on a configured repository can start runs, and each run can spend up to `limits.perRunUsd`. Relabeling cancels the previous run but not what it already spent, and there is no daily or per-repository cap. Raise `minimumPermission` if `write` is too broad, and rely on the model key's spend limit as the backstop.
- **PRs from forks.** PR Reviewer fetches `refs/pull/<n>/head`, which includes PRs from forks, and runs `verify` on that code. Anyone with `minimumPermission` decides which PRs get reviewed, so don't label a PR whose code you wouldn't run.
- **Prompt injection.** Issue text, comments, code, and PR diffs all reach models. The invariants limit what an injected agent can do (no GitHub writes, no choice of targets, a human gate before anything merges), but its output still lands in comments, specs, and draft PRs that people read. Review specs before approving them and PRs before merging them. The eval suite includes injection cases (`evals/cases/injection-*.json`).
- **The Render API key.** Both services hold a key with access to the whole workspace. Anyone who gets the gateway's environment can start and cancel tasks and manage other resources in that workspace. Deploy the factory in a workspace dedicated to it if that matters to you.
- **Run data in the Dashboard.** Task inputs and results, including issue numbers and outcomes, are visible to anyone with access to `factory-workflows` in the Render Dashboard.
