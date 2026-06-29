-- Schedules: relax the last_run_id FK to ON DELETE SET NULL.
--
-- A schedule records its most recent run in last_run_id (FK → runs.id). Retention
-- trims old terminal runs (DELETE FROM runs); with the default NO ACTION FK, a
-- schedule still pointing at a trimmed run would block that delete and fail the
-- retention pass. SET NULL lets the run be trimmed while the schedule survives
-- (its last_run_id simply clears), consistent with "schedules never auto-expire".
--
-- Idempotent: drop-if-exists then re-add on every boot, inside the migration's
-- advisory-lock transaction.
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_last_run_id_fkey;
ALTER TABLE schedules
  ADD CONSTRAINT schedules_last_run_id_fkey
  FOREIGN KEY (last_run_id) REFERENCES runs(id) ON DELETE SET NULL;
