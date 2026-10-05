CREATE TABLE IF NOT EXISTS copilot_requests (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    notebook_id       uuid NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    action            text NOT NULL CHECK (action IN ('ask', 'edit')),
    cell_id           text,
    prompt            text NOT NULL,
    model             text NOT NULL,
    status            text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    stop_reason       text,
    answer            text,
    proposal          jsonb,
    context_tokens    integer,
    context_items     jsonb,
    prompt_tokens     integer,
    completion_tokens integer,
    usage_estimated   boolean,
    cost_usd          numeric(12, 6),
    steps             integer,
    latency_ms        integer,
    first_token_ms    integer,
    error             text,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS copilot_requests_notebook_idx ON copilot_requests (notebook_id, created_at DESC);
