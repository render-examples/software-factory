# render-factory

An open-source, self-hosted template for building autonomous coding agent workflows on [Render](https://render.com). Define agents as pure config, compose them as durable Render Workflows, and connect them to Slack and GitHub.

[Quick start](#quick-start) · [What it does](#what-it-does) · [Who is this for](#who-is-this-for) · [Architecture](#architecture) · [Customize](#customize) · [Deploy](#deploy-to-render)

---

## Quick start

```bash
git clone https://github.com/<you>/render-factory.git
cd render-factory
npm install
npm run start:gateway      # Hono server on :3000
npm run start:workflows    # Render Workflows task host
```

Set your environment variables (see [below](#environment-variables)), point a GitHub webhook at `/channels/github`, and label an issue — the factory takes it from there.

---

## What it does

You define agents as pure config, bridge them to Render tasks, and compose them in workflows. The agents receive work from Slack and GitHub, execute code via the Claude Agent SDK, and deliver results back automatically.

The template ships with three connected workflows:

- **Spec to PR (`spec-to-pr`)** — GitHub issue or assistant-dispatched spec → triage → research → plan → implementation → tests → pull request.
- **PR Review (`pr-review`)** — Opened/updated PR → security, performance, correctness, tests, and lint reviewers fan out in parallel → judge synthesizes a GitHub review.
- **PR Fix (`pr-fix`)** — Review feedback on an agent branch → implementer fixes the issues → pushes.

Plus an **interactive assistant** — Slack message or API thread → Claude agent turn with multi-turn memory → reply. The assistant can explore repos, answer questions, and dispatch `spec-to-pr`.

## Who is this for

- **Lean engineering teams** that want fully customizable background coding workflows without purchasing a closed agent control plane.
- **Teams that want self-hosted cloud coding agents embedded in their existing workflow.** The agent meets you where you already are.
- **Platform-minded engineers** who want to customize agents, workflow stages, models, tools, and approval boundaries.
- **Anyone outgrowing one-shot CLI agents.** If you've been using Claude Code, Codex, or similar tools and want an agent that persists across sessions, handles multi-step work durably, and integrates with your team's channels — this is the next step.

---

## Architecture

```
Gateway (Hono web service)
├── POST /channels/slack     → verify, parse, dispatch assistant task
├── POST /channels/github    → verify, parse, dispatch spec-to-pr/pr-review/pr-fix
├── POST /threads/:id/messages → dispatch assistant task with thread context
└── GET /health

Render Workflows host
├── assistant task           → Claude Agent SDK with thread history from KV
├── researcher task          → Claude Agent SDK (read-only exploration)
├── planner task             → Claude Agent SDK (structured plan)
├── implementer task         → Claude Agent SDK (code changes + tests)
├── spec-to-pr workflow      → triage → research → plan → implement → PR
├── pr-review workflow       → fan-out reviewers → judge → GitHub review
└── pr-fix workflow          → implementer → push fixes

Render Key Value (Redis)
└── thread:{id} → conversation history (multi-turn memory)
```

- **Gateway** — thin Hono HTTP server (~220 lines). Verifies webhooks, manages threads, dispatches Render tasks. No agent execution.
- **Workflows host** — runs all agent compute on Render Workflows. Each agent is a Render task powered by the Claude Agent SDK. Composition workflows chain tasks together.
- **Key Value** — thread memory for interactive conversations. No Postgres.
- **SDK** — 165 lines. `Agent()` for config, `agentTask()` to bridge to Render tasks, `md` for prompts, and a KV-backed thread store.

---

## Customize

### Define an agent

Agents are pure config — a prompt, tools, and constraints:

```ts
import { Agent, md } from "../sdk/index.js";

export const researcher = Agent({
  id: "researcher",
  prompt: md`
    You are the Research phase. Explore the codebase read-only.
    Produce a concise research brief.
  `,
  tools: ["Read", "Bash", "Grep", "Glob"],
  budget: { maxIterations: 30 },
  plan: "standard",
});
```

### Bridge to a Render task

```ts
import { agentTask } from "../sdk/index.js";
import { researcher } from "../agents/index.js";

export const researchTask = agentTask(researcher);
```

### Compose in a workflow

Workflows are bare Render tasks that chain agent tasks:

```ts
import { task } from "@renderinc/sdk/workflows";
import { researchTask, planTask, implementTask } from "../tasks/index.js";

export const specToPr = task(
  { name: "spec-to-pr", plan: "standard" },
  async function specToPr(input) {
    const research = await researchTask({ message: input.description });
    const plan = await planTask({ message: research });
    return implementTask({ message: plan });
  },
);
```

### Add a channel

Channels are Hono route handlers that verify webhooks and dispatch tasks:

```ts
app.post("/channels/github", async (c) => {
  // verify signature, normalize event, startTask("spec-to-pr", [event])
});
```

---

## File structure

```
render-factory/
├── sdk/                    Framework (165 lines)
│   ├── agent.ts            Agent() + agentTask() + md
│   ├── threads.ts          KV-backed thread store
│   └── index.ts            Barrel
├── app/
│   ├── agents/index.ts     Pure agent configs (prompts, tools)
│   ├── tasks/index.ts      agentTask() bridge (one per agent)
│   ├── workflows/          Bare Render task() composition
│   ├── gateway/            Hono server + channel handlers
│   ├── lib/                Domain helpers (GitHub REST client)
│   └── src/                Entrypoints (server.ts, workflows.ts)
├── package.json
├── tsconfig.json
├── render.yaml             Blueprint (web + workflows + KV)
└── README.md
```

---

## Deploy to Render

1. Fork this repository.
2. Create a [Blueprint](https://dashboard.render.com/select-repo?type=blueprint) from `render.yaml`. It provisions:
   - `factory-gateway` — web service
   - `factory-workflows` — Render Workflows host
   - `factory-kv` — Key Value store
3. Set the environment variables below on each service.
4. Create a Render Workflows service manually (until Blueprints support it), connect this repo, and set the start command to `npx tsx app/src/workflows.ts`.
5. Point your GitHub webhook at `https://<gateway>/channels/github`.
6. Point your Slack Events API at `https://<gateway>/channels/slack`.

## Environment variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `ANTHROPIC_API_KEY` | Workflows | Claude API key |
| `REDIS_URL` | Both | Render Key Value connection string |
| `RENDER_WORKFLOW_SLUG` | Gateway | Workflows service slug for task dispatch |
| `GITHUB_TOKEN` | Workflows | Fine-grained PAT for repo operations |
| `GITHUB_WEBHOOK_SECRET` | Gateway | GitHub webhook signature verification |
| `SLACK_SIGNING_SECRET` | Gateway | Slack request signing verification |
| `SLACK_BOT_TOKEN` | Gateway | Slack bot OAuth token for replies |

---

## License

MIT
