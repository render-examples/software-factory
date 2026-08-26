# Sprint 22 — Dev-Mode Trace Viewer

**Status:** COMPLETE
**Wave:** 4 — DX, Operability & Ship
**Depends on:** 10 (span projections), 16 (gateway read routes), 17 (SSE)
**Unblocks:** —

---

## Goal

Ship a lightweight, read-only dev-mode trace viewer (ported from the template's `src/ui/`) served by the gateway, so developers can inspect runs, the span tree, costs, and the live SSE stream locally without external tooling. This is the MVP stopgap; the full operator-UI SPA from [L6](../specs/06-operator-ui.md) is deferred post-MVP.

---

## Foundational decisions in play

- [D8](../specs/00-foundations.md#d8--observable-by-default-every-unit-is-a-span-postgres-is-source-of-truth) — full visibility with no external collector; the viewer is a read layer over existing routes/projections.
- Per [Porting Map §3](../specs/porting-map.md#3-not-ported-intentionally-dropped): the harness operator UI is deferred; the template trace UI serves as the initial dev-mode viewer.

---

## Scope

**In:**
- **Port the template trace UI** (`agent-workflows-template/src/ui/`) as a React + Vite SPA served by the gateway at `/ui` (and `/ui/*` for client routing).
- **Run list:** `GET /runs` with status/cost/duration/trigger columns + basic filter (workflow/status) and keyset pagination.
- **Run detail / span tree:** `GET /runs/:id` + `/spans` + `/tool-calls` — collapsible tree mirroring `SpanRecord.parentId`, with per-kind attributes (model/tokens/cost/latency/stop reason) and per-agent cost breakdown.
- **Live trace stream:** `GET /runs/:id/stream` (SSE) — build the span tree incrementally from events; auto-reconnect from last `seq`.
- **Read-only:** the viewer does not edit agents/workflows; it is a dev inspector. (Approval *display* may show pending approvals with a link, but resolve actions are optional for MVP — see notes.)
- **Auth:** same API-key bearer as the gateway; key entered on load or via dev query param, stored in memory.
- **Build:** Vite static bundle embedded in `@render-factory/gateway`; served as static assets; no separate deployment.

**Out:**
- The full operator-UI feature set from [L6](../specs/06-operator-ui.md) (thread browser, resolved-approvals tab, cost-summary header polish, write actions beyond approval) — deferred post-MVP.
- Charts/timeseries/dashboards (explicitly out of operator-UI scope too).
- Custom theming/white-labeling.

---

## Deliverables

`@render-factory/gateway`:
- Ported/adapted React + Vite SPA under the gateway package, built to static assets.
- `/ui` + `/ui/*` static serving + SPA fallback.
- Run list, run detail/span tree, live SSE stream views wired to existing routes.
- In-memory API-key handling for fetch/SSE.

---

## Porting source

- **T — Trace UI:** `agent-workflows-template/src/ui/` (`api.ts`, `lib/spans.ts`, `lib/format.ts`, `vite.config.ts`) + `src/server/ui.ts` (static mount) — **direct lift** as the dev-mode trace viewer; adapt API calls to the gateway routes and the `SpanRecord`/`RunEvent` shapes.
- **H — UI mount reference (optional):** `render-agent-harness/.../web/src/ui-mount.ts` — reference for serving an SPA from the web service if the template's mount needs adapting to Hono.

---

## Implementation notes

1. **Read layer only:** all data comes from existing Sprint 16/17 routes — no new backend routes or stores. If a needed read is missing, prefer adding it in the gateway sprint scope rather than a UI-specific backend.
2. **Span tree from `parentId`:** render the collapsible tree from `listSpans`; agent/workflow nodes start expanded, llm/tool nodes collapsed; expand a tool node to lazy-load its input/output from `/tool-calls`.
3. **Live = SSE event reducer:** the live view reduces `RunEvent`s into the same tree the static view renders from `/spans`; reconnect from last `seq`. Treat `text.delta` as absent (post-MVP) — text arrives via `message.assistant`.
4. **Keep it light:** React + a lightweight tree/table; no heavy UI framework; native `EventSource` (or a small reconnecting wrapper).
5. **Embed in the gateway build** so there's no separate deploy; the Vite bundle is a static asset shipped with the package.

---

## Exit criteria / acceptance

- Visiting `/ui` (with a valid key) shows the run list with status/cost/duration/trigger and filters/pagination.
- Clicking a run shows the span tree with correct nesting and per-kind attributes + per-agent cost; expanding a tool node loads its input/output.
- The live view streams a running agent's spans incrementally and reconnects from `seq` after a drop.
- The bundle builds via Vite and is served as static assets from the gateway at `/ui`/`/ui/*` with SPA fallback.
- All requests carry the API key; an invalid key surfaces an auth error in the UI.

---

## Risks / open questions

- **Template UI drift vs new shapes:** the template UI predates the event-log projections; adapt its API/data layer to `RunEvent`/`SpanRecord`/projection routes (the visual components should largely carry over).
- **Approval resolve in the dev viewer:** decide whether to include approve/deny actions (the one write action allowed by L6) in MVP or keep strictly read-only (recommend display-only with a link to the `/approvals` API; full action UI post-MVP).
- **Bundle size in the gateway package:** keep the SPA lean; it's a dev tool, but it ships in the gateway package.
