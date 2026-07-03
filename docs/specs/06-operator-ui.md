# Operator UI

**Status:** IMPLEMENTED (living)
**Date:** 2026-07-02
**Layer:** L6 - operator-facing console behavior.

This document reflects the current React SPA served by gateway route `/ui`.

---

## Purpose

The operator UI is a control surface for:

- starting work (chat and workflow dispatch),
- monitoring runs and traces,
- resolving input requests (primarily approval-kind requests),
- managing schedules and OAuth connections,
- running maintenance operations.

It is intentionally operator-centric, not an end-user chat product.

---

## Information Architecture

Primary sections (hash-routed):

- `chat`
- `workflows`
- `schedules`
- `runs`
- `approvals`
- `connections` (shown only when OAuth providers configured)
- `ops`

Implementation files:

- app shell/router: `packages/gateway/ui/src/App.tsx`
- route state: `packages/gateway/ui/src/state/router.ts`
- nav sections: `packages/gateway/ui/src/state/sections.tsx`

---

## Authentication Model

Current auth flow differs from historical bearer-only UI docs:

1. UI prompts for API key.
2. UI calls `/ui/login`.
3. Gateway sets signed httpOnly cookie session.
4. UI requests use same-origin credentials.

Relevant code:

- UI gate: `packages/gateway/ui/src/components/AuthGate.tsx`
- cookie/session wiring: `packages/gateway/src/ui-session.ts`
- principal endpoint: `/whoami` (`packages/gateway/src/app.ts`)

SSE still supports query-key fallback for non-cookie clients, but UI primarily uses session cookies.

---

## Core Views

## Chat

Files:

- `packages/gateway/ui/src/views/ChatView.tsx`
- `packages/gateway/ui/src/api/sse.ts`

Behavior:

- left pane conversation list + right pane transcript,
- one run per message turn in a thread,
- inline pending input cards for approval-kind requests,
- live `text.delta` rendering for current turn,
- composer disabled while thinking **and** while an approval-kind input is pending,
- input pause keeps composer enabled for resume-by-message.

## Runs

Files:

- `packages/gateway/ui/src/views/RunsView.tsx`
- `packages/gateway/ui/src/views/RunDetailView.tsx`

Behavior:

- paginated run listing with filter rails,
- run detail with trace lens, events lens, message lens,
- child-run stitching via `/runs/:id/children`,
- cancel action for active runs.

## Approvals (Input Kind = `approval`)

File:

- `packages/gateway/ui/src/views/ApprovalsView.tsx`

Behavior:

- pending queue and resolved history,
- approve/deny with optional reason,
- links to run context.

## Workflows and Schedules

Files:

- `packages/gateway/ui/src/views/WorkflowsView.tsx`
- `packages/gateway/ui/src/views/SchedulesView.tsx`

Behavior:

- manual workflow dispatch with JSON input,
- schedule CRUD and run-now actions.

## Connections and Ops

Files:

- `packages/gateway/ui/src/views/ConnectionsView.tsx`
- `packages/gateway/ui/src/views/OpsView.tsx`

Behavior:

- provider connection status + connect/disconnect,
- queue metrics and maintenance endpoint actions.

---

## Backend Dependencies

UI relies on existing gateway routes:

- runs: `/runs`, `/runs/:id`, `/runs/:id/spans`, `/runs/:id/events`, `/runs/:id/children`, `/runs/:id/cancel`
- workflows: `/workflows`, `/workflows/:name`
- threads/chat: `/threads`, `/threads/:id`, `/threads/:id/messages`, `/threads/:id/stream`
- HITL inputs: `/inputs`, `/inputs/:id/provide`, `/runs/:id/input`
- schedules: `/schedules*`, `/admin/schedules/tick`
- ops: `/admin/jobs`, `/admin/retention`, `/admin/runs/reap`
- oauth: `/connections`, `/oauth/:provider/*`
- global live rail: `/events/stream`

---

## Live Update Model

UI combines:

- projection refetch on durable event notifications,
- direct streaming render for chat token deltas.

Stream routes:

- run stream (`/runs/:id/stream`)
- thread stream (`/threads/:id/stream`)
- global stream (`/events/stream`)

Global stream is forward-only (no catch-up replay), so UI keeps periodic/refetch-based count accuracy.

---

## Known Implementation Notes

- Conversation-list "filter by user id" in chat view is currently UI-side input without effective server-side filtering for operator role.
- Global stream does not replay historical events on connect.
- Connections nav is capability-gated by successful provider probe.

