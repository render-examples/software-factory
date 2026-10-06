# Configuration

## `factory.config.ts`
| Key | Purpose |
|---|---|
| `repos[0]` | Target repo, install and verify commands, optional dev server and preview service |
| `labels` | Trigger label names |
| `commandPrefix` | Comment command prefix; default `/factory` |
| `minimumPermission` | Permission required to trigger a run; default `write` |
| `agents.runner` | `claude` or `openai` |
| `agents.models` | Model per tier (`small`, `medium`, `large`) |
| `review.specialists` | Reviewers pr-reviewer runs |
| `sandbox` | Timeouts and network policy |
| `limits` | Repair rounds, per-run budget, size caps |
| `pricing` | Token prices for cost tracking |

## Environment variables
| Variable | Used by |
|---|---|
| `DATABASE_URL` | All |
| `GITHUB_WEBHOOK_SECRET` | Gateway |
| `FACTORY_ADMIN_TOKEN` | Gateway |
| `PORT` | Gateway (optional) |
| `RENDER_API_KEY` | Dispatcher, Workflows, Maintenance |
| `RENDER_WORKFLOW_SLUG` | Dispatcher |
| `RENDER_WORKSPACE_ID` | Workflows, Maintenance |
| `GITHUB_APP_ID` | Workflows, Maintenance |
| `GITHUB_APP_PRIVATE_KEY` | Workflows, Maintenance |
| `GITHUB_APP_INSTALLATION_ID` | Workflows, Maintenance |
| `ANTHROPIC_API_KEY` | Workflows |
| `OPENAI_API_KEY` | Workflows |
| `FACTORY_PUBLIC_URL` | Workflows (optional) |
| `GITHUB_API_URL` | Workflows, Maintenance (optional) |

`dev:*` scripts load `.env`. `start:*` scripts don't.
