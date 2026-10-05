CREATE TABLE IF NOT EXISTS notebooks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- A notebook's Yjs state is the merge of its snapshot and every update row after it.
-- Updates are append-only; compaction folds them into the snapshot and deletes exactly
-- the rows it read, so an insert racing with compaction is never lost.
CREATE TABLE IF NOT EXISTS doc_snapshots (
    notebook_id  uuid PRIMARY KEY REFERENCES notebooks(id) ON DELETE CASCADE,
    state        bytea NOT NULL,
    updates_merged bigint NOT NULL DEFAULT 0,
    compacted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS doc_updates (
    id           bigserial PRIMARY KEY,
    notebook_id  uuid NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    update       bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_updates_notebook_idx ON doc_updates (notebook_id, id);
