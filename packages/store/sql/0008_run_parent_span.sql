-- render-agents schema: runs.parent_span_id — cross-run parent linkage.
-- Dependency order position: 8 (ALTER runs)

ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_span_id TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_parent_span ON runs(parent_span_id)
    WHERE parent_span_id IS NOT NULL;
