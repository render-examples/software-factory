# Sprint 20 — Webhooks, Connectors, Schedules

**Status:** DRAFT
**Wave:** 3 — Platform & Serving
**Depends on:** 12 (workflow dispatch), 16 (gateway core)
**Unblocks:** —

---

## Goal

Complete the trigger surfaces beyond direct HTTP: user-authored inbound webhook adapters, package-contributed connectors (sharing the same dispatch mechanism in a separate namespace), and cron-scheduled triggers via Render Cron — so external events and schedules can start workflow runs.

---

## Foundational decisions in play

- Webhooks/connectors/schedules from [Platform → Webhooks](../specs/03-platform.md#webhooks), [Connectors](../specs/03-platform.md#connectors), [Schedules](../specs/03-platform.md#schedules).
- Cron and webhooks are **trigger types, not runtimes** ([Porting Map §3](../specs/porting-map.md#3-not-ported-intentionally-dropped)).

---

## Scope

**In:**
- **Webhooks** (user-authored, auto-discovered from `webhooks/*.ts`):
  - `WebhookAdapter` (`name`, `match(req) → WebhookMatch | null`, `parse(req)`); mounted at `POST /webhooks/:name`.
  - On match → dispatch `(workflow, trigger)` with parsed input.
- **Connectors** (package-contributed):
  - `ConnectorSpec` (`key`, `name`, `handle(req, ctx) → WebhookMatch | null`); auto-discovered from tool packages' optional `connectors` export; mounted at `POST /connectors/:key`.
  - Shares dispatch with webhooks but a **separate namespace** (no collisions).
- **Schedules (MVP = Render Cron):** scheduled triggers use Render Cron directly in `render.yaml` — a cron job hits `POST /workflows/:name` on a schedule. **No** `schedules` table usage, runtime API, or reconciliation in MVP (the table + `ScheduleStore` interface exist from Sprint 05 as the contract for a future runtime-managed sprint).
- **Discovery + collision validation** for `webhooks/` (validated in Sprint 02); connector keys validated at mount.

**Out:**
- Runtime-managed schedules (the `ScheduleStore`/`schedules` reconciliation loop) — explicitly deferred per [Platform → Schedules](../specs/03-platform.md#schedules).
- Specific provider connectors (GitHub/Slack/Linear) as shipped packages — the *mechanism* is here; concrete packages are example/user code.

---

## Deliverables

`@render-factory/gateway`:
- `webhooks/` discovery + `POST /webhooks/:name` mount + dispatch.
- Connector discovery (from tool packages' `connectors` export) + `POST /connectors/:key` mount + dispatch.
- Cron trigger support documented for `render.yaml` (the route already exists: `POST /workflows/:name`).
- Namespacing so webhook names and connector keys never collide.

---

## Porting source

- **T — Webhooks:** `agent-workflows-template/src/server/webhooks/*` (`github.ts`, `clay.ts`) — reference for the adapter shape; adapt to `WebhookAdapter` + auto-discovery + Hono mount.
- **H — Connectors:** `render-agent-harness/.../web/src/connector-mount.ts`, `web/src/routes/connectors.ts` — port the connector mount/dispatch + namespace separation; adapt to `ConnectorSpec`.
- **T — Tool system (connectors export):** `agent-workflows-template/src/engine/tool*.ts` — add the optional `connectors` export contribution (seam noted in Sprint 07).

---

## Implementation notes

1. **Webhooks and connectors share dispatch, differ in source:** both produce a `WebhookMatch` (`workflow` + `trigger`) → `WorkflowDefinition.dispatch`. The only difference is who authors them (user vs tool package) and the route namespace (`/webhooks/:name` vs `/connectors/:key`).
2. **`match`/`parse` split:** `match` cheaply decides routing (and can return `null` to pass); `parse` extracts the workflow input (may read the body once — careful with body consumption in Hono).
3. **Cron is config, not code:** document the `render.yaml` cron job that POSTs `/workflows/:name` with a static input + the API key; no schedule table involved in MVP. Keep the `ScheduleStore` interface unused-but-present.
4. **Connector discovery** scans loaded tool packages for an optional `connectors` export at startup and mounts each; key collisions error at mount.
5. **`trigger` propagates** onto the run (`RunRecord.trigger`) for observability/attribution (the run-list "Trigger" column).

---

## Exit criteria / acceptance

- A `webhooks/github.ts` adapter is auto-discovered; a matching `POST /webhooks/github` dispatches the target workflow with parsed input; a non-matching request passes/404s appropriately.
- A tool package exporting `connectors` mounts at `POST /connectors/:key` and dispatches; webhook and connector namespaces never collide.
- A documented `render.yaml` cron job hitting `POST /workflows/:name` triggers runs on schedule (validated locally by simulating the cron POST).
- `RunRecord.trigger` reflects the trigger source (webhook/connector/cron/api/thread).
- The `schedules` table/`ScheduleStore` remain present but unused in MVP.

---

## Risks / open questions

- **Body consumption / signature verification:** webhook signature checks (e.g. GitHub HMAC) need the raw body; ensure `match`/`parse` can verify signatures before dispatch without double-reading the stream.
- **Connector discovery scope:** how tool packages advertise `connectors` (export convention) and how the gateway finds them (only for installed tool sources referenced by agents?) — define the discovery boundary.
- **Cron auth:** the cron POST must carry the API key; document securely (Render env var in the cron job spec).
