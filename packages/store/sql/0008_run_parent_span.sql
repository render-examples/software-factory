-- render-agents schema: runs.parent_span_id — cross-run parent linkage.
-- Dependency order position: 8 (ALTER runs)
--
-- A run spawned by another run (workflow `.task()`/`.run()` fan-out, or an LLM
-- subagent) records the parent span it hangs off in `parent_span_id`. Top-level
-- roots have NULL. This lets the operator UI hide child runs from the top-level
-- runs list and stitch them into the parent run's trace. It is folded from the
-- run.started event's parent_span_id (a read projection, not new run state).

ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_span_id TEXT;

-- Children lookup: runs hanging off a given set of parent spans.
CREATE INDEX IF NOT EXISTS idx_runs_parent_span ON runs(parent_span_id)
    WHERE parent_span_id IS NOT NULL;
