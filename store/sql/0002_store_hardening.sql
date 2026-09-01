ALTER TABLE render_factory.run_executions
    ADD COLUMN IF NOT EXISTS failure_counted BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'run_executions_id_run_unique'
          AND conrelid = 'render_factory.run_executions'::regclass
    ) THEN
        ALTER TABLE render_factory.run_executions
            ADD CONSTRAINT run_executions_id_run_unique UNIQUE (id, run_id);
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'run_steps_execution_run_fk'
          AND conrelid = 'render_factory.run_steps'::regclass
    ) THEN
        ALTER TABLE render_factory.run_steps
            ADD CONSTRAINT run_steps_execution_run_fk
            FOREIGN KEY (execution_id, run_id)
            REFERENCES render_factory.run_executions(id, run_id);
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'run_events_execution_run_fk'
          AND conrelid = 'render_factory.run_events'::regclass
    ) THEN
        ALTER TABLE render_factory.run_events
            ADD CONSTRAINT run_events_execution_run_fk
            FOREIGN KEY (execution_id, run_id)
            REFERENCES render_factory.run_executions(id, run_id);
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS render_factory.counters (
    name   TEXT PRIMARY KEY,
    value  BIGINT NOT NULL
);

INSERT INTO render_factory.counters (name, value)
VALUES (
    'event_position',
    COALESCE((SELECT max(position) FROM render_factory.run_events), 0)
)
ON CONFLICT (name) DO UPDATE SET
    value = GREATEST(
        render_factory.counters.value,
        EXCLUDED.value
    );

ALTER TABLE render_factory.run_events
    ALTER COLUMN position DROP IDENTITY IF EXISTS;

INSERT INTO render_factory.schema_migrations (version)
VALUES (2)
ON CONFLICT (version) DO NOTHING;
