# Future Considerations

**Status:** FORWARD-LOOKING (not implemented)
**Date:** 2026-07-02

This appendix tracks extension seams that should remain open while keeping current docs implementation-accurate.

---

## Sandboxes

Potential future capability: stateful execution sandboxes for coding-style agents.

Motivation:

- agent loop compute and code-execution workspace are different resources,
- coding workflows benefit from persistent filesystem/process context across steps/turns.

Current status:

- no sandbox provider is implemented in runtime,
- no built-in sandbox tool source is shipped.

Possible integration seam:

- optional runtime service (for acquisition/lifecycle),
- tool source exposing sandbox actions (`exec`, file I/O, port expose),
- support for run-scoped and thread-scoped sandbox lifetime models.

Design constraints to preserve:

- keep sandbox actions within existing approval/idempotency/trace model,
- avoid bypassing event-log-first execution semantics,
- ensure cleanup and retention of sandbox metadata are explicit.

---

## Additional Deferred Areas

- richer UI analytics and long-horizon dashboards,
- stronger per-user/per-org auth and RBAC beyond shared-key operator mode,
- per-agent context-strategy wiring from frontmatter (`context.compaction`),
- broader runtime-level policy packs beyond current hook/event-interceptor path.

These are deferred until implementation work exists; this file should not be treated as active behavior documentation.

