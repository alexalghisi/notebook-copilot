CREATE TABLE IF NOT EXISTS runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notebook_id    uuid NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    cell_id        text NOT NULL,
    source         text NOT NULL,
    status         text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    columns        jsonb,
    rows           jsonb,
    row_count      integer,
    truncated      boolean NOT NULL DEFAULT false,
    error          text,
    error_position integer,
    duration_ms    integer,
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz
);
CREATE INDEX IF NOT EXISTS runs_notebook_cell_idx ON runs (notebook_id, cell_id, started_at DESC);
