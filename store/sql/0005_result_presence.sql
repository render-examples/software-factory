ALTER TABLE render_factory.runs
    ADD COLUMN IF NOT EXISTS has_result BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE render_factory.runs
    ADD COLUMN IF NOT EXISTS has_input BOOLEAN NOT NULL DEFAULT false;

UPDATE render_factory.runs
SET has_result = true
WHERE result IS NOT NULL;

UPDATE render_factory.runs
SET has_input = true
WHERE input IS NOT NULL;

INSERT INTO render_factory.schema_migrations (version)
VALUES (5)
ON CONFLICT (version) DO NOTHING;
