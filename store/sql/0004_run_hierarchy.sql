DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'runs_id_root_unique'
          AND conrelid = 'render_factory.runs'::regclass
    ) THEN
        ALTER TABLE render_factory.runs
            ADD CONSTRAINT runs_id_root_unique UNIQUE (id, root_run_id);
    END IF;
END;
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM render_factory.runs child
        JOIN render_factory.runs parent ON parent.id = child.parent_run_id
        WHERE child.parent_run_id IS NOT NULL
          AND child.root_run_id <> parent.root_run_id
    ) THEN
        RAISE EXCEPTION 'Cannot apply run hierarchy constraint: cross-root parent exists';
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'runs_parent_root_fk'
          AND conrelid = 'render_factory.runs'::regclass
    ) THEN
        ALTER TABLE render_factory.runs
            ADD CONSTRAINT runs_parent_root_fk
            FOREIGN KEY (parent_run_id, root_run_id)
            REFERENCES render_factory.runs(id, root_run_id)
            ON DELETE CASCADE
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END;
$$;

INSERT INTO render_factory.schema_migrations (version)
VALUES (4)
ON CONFLICT (version) DO NOTHING;
