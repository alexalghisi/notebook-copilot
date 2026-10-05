# notebook-copilot

A small collaborative SQL notebook with a copilot. Several people edit the same notebook live, run cells against Postgres and see each other's results, and an assistant can answer questions about the notebook or fix a broken cell. The interesting parts are the ones a real product has to get right: edits that merge instead of overwrite, even across server processes and after being offline; a copilot that sees the right slice of the notebook within a token budget, checks its SQL before proposing it, and stops before it overspends; edits from the copilot that arrive as a reviewable diff and go through the same CRDT as everyone's typing; and an eval suite that measures whether the copilot actually works.

![Two browsers on two server processes edit one notebook, then the copilot fixes a broken cell and the fix appears in both](docs/preview.gif)

The copilot runs against any OpenAI-compatible endpoint when `LLM_API_KEY` is set. Without a key it uses a deterministic offline model, so the app, the tests, CI and the GIF above all run without network access.

## How it works

### Collaboration

**Notebooks are Yjs documents.** A notebook is a `Y.Array` of cells, each with its own `Y.Text`, plus a map of run summaries (`src/shared/notebook.ts`). Two people typing in the same cell merge character by character. Result rows are deliberately not in the document: they are stored once per run in Postgres and fetched by id, so the CRDT history doesn't grow with every query result.

**Wire protocol.** The browser uses the stock `y-websocket` provider. The server side is my own (`src/server/collab/room.ts`): it speaks the same sync and awareness messages, which keeps the client off-the-shelf while the server controls persistence and fan-out.

**Several server processes share a room through Redis.** Each process holds at most one `Room` per notebook. A change is applied once to the local `Y.Doc`, then the update handler sends it to local websocket peers, publishes it on a Redis channel unless it came from there, and queues it for Postgres only if this process is where it entered the system. A process that opens a room late subscribes first, loads from Postgres, then sends a sync step 1 over Redis; the processes that already hold the room reply (addressed, not broadcast) with whatever hasn't been persisted yet. Server-side reads such as "run this cell" wait for that reply, or 150 ms, before reading the document. Presence (who's here, cursors) travels the same way and is removed when a socket closes.

**Persistence with compaction.** Updates are batched for a few milliseconds, merged with `Y.mergeUpdates` and appended to `doc_updates`. After 200 rows (configurable), the log is folded into `doc_snapshots` (`src/server/collab/docStore.ts`). Compaction holds a per-notebook advisory lock and deletes exactly the row ids it read, not "everything up to id N", so an insert that commits during compaction is never lost. Yjs updates are idempotent and commutative, so loading is simply "apply the snapshot and every row". A test runs four writers and concurrent compactions against a real database and checks every character survives.

**Offline edits merge.** If a socket drops, the client keeps editing its local document; on reconnect the provider and server exchange state vectors and each side sends only what the other is missing. The connection pill in the header doubles as a "work offline" switch, which the end-to-end test uses.

### Running cells

SQL cells run against a separate sample database (a small shop: customers, products, orders, order items) generated from a fixed seed so every machine has the same rows (`src/server/sample/dataset.ts`).

- The connection role can only `SELECT`: no `CREATE`, no `TEMP`, read-only transactions by default.
- On top of that, every statement runs in its own `BEGIN READ ONLY` transaction with `SET LOCAL statement_timeout` (`src/server/exec/sqlRunner.ts`).
- Rows are read through a cursor, `rowLimit + 1` at a time, so `select * from huge_table` stops at the limit instead of buffering everything, and the extra row tells us the result was cut off.
- Cursors use the extended protocol, which refuses `select 1; delete from orders`.
- Errors keep Postgres' SQLSTATE and character position, adjusted for leading whitespace, so the UI and the copilot can point at the right place.

The run is stored in `runs`, and the cell's summary (run id, status, row count, error) is written into the document by the server. Every collaborator gets it through normal sync and fetches the rows by run id. A run that finishes after a newer run of the same cell doesn't overwrite its output.

### GraphQL API

`graphql-yoga` with a schema-first SDL (`src/server/graphql/schema.graphql`): notebooks with their live cells (read from the room, not from a stale copy), runs and their rows, the sample schema, `runCell`, copilot request history, and a `copilot` subscription that streams a request's progress over SSE on the same endpoint. Input errors come back as `BAD_USER_INPUT`; anything unexpected is masked.

### Copilot

**Context builder** (`src/server/copilot/context.ts`). The model gets a packed view of the notebook within a token budget, measured with a real tokenizer (`gpt-tokenizer`, o200k_base). Candidates are ranked in tiers:

1. The focus cell with its last error.
2. Schemas of tables the focus cell reads or the prompt mentions ("customer" finds `customers`).
3. Other cells by relevance: shared tables, shared terms, a recent error, distance from the focus cell.
4. Schemas of tables those cells use.

Packing is greedy. An item that doesn't fit is truncated to whole lines if a useful prefix fits, otherwise dropped, and every decision is reported with its reason. The rendered text is then measured as a whole, and the lowest-ranked item is removed until it fits, so the budget is a hard limit rather than an estimate. Selected cells render in notebook order with an "N other cells not shown" line. The UI shows this report under "Context" in the copilot panel. Tests sweep budgets from 0 to 1,500 tokens and check the exact count every time.

**Agent loop** (`src/server/copilot/agent.ts`). Four tools: `inspect_schema`, `run_query` (read-only, 20-row preview), `read_cell_output` and `propose_edit`. The loop stops when the model answers without a tool call, when it proposes an edit (the user takes over), or before a limit would be crossed. The limits are steps, total tokens and dollars. Cost and token checks project the size of the next request before sending it, so the loop stops *before* overspending. Tool results are truncated to a token cap before going back to the model. Tool exceptions become error results the model can react to, and a model failure ends the request with a recorded error instead of a crash.

**Models behind one interface** (`src/server/copilot/model.ts`):

- `OpenAIModel` streams chat completions from any OpenAI-compatible server. It assembles tool-call fragments by index and retries 429/5xx, honouring `Retry-After`, but only before the first byte: once text has reached the user, a retry would duplicate it. Tests run it against a local fake server with injected faults: rate limits, 5xx, malformed chunks, connections cut mid-stream, hangs and aborts.
- `OfflineModel` reads the same prompt and drives the same tools. It inspects the schema, repairs the SQL from the Postgres error (closest column or table, a missing `GROUP BY`, a misspelled keyword, an unknown alias, an ambiguous column), runs the result, repairs again if a new error appears, and proposes the edit once a query succeeds. For "write a query" requests it uses a small planner over the shop schema (measure, dimension, filters, limit). It is a test double and a demo model, not an attempt at understanding, and the evals show where it runs out.

Every request is recorded in `copilot_requests`: prompt, model, stop reason, context size, prompt and completion tokens (marked "counted locally" when the server didn't report usage), cost, steps, latency and time to first token.

**Proposals go through the CRDT** (`src/shared/proposal.ts`). A proposal carries the cell source the copilot saw and the new source. When it arrives in the browser, the character diff is anchored to the cell with Yjs relative positions. If a collaborator types elsewhere in the cell before the user clicks Accept, the edits still land on the right characters and the collaborator's typing survives. If the cell already changed before the proposal arrived, the panel says so and offers "Replace anyway". Accepting applies one Yjs transaction, so collaborators get it like any other edit, and then runs the cell.

### Evals

`evals/` holds 25 tasks: 13 "fix this cell" with a broken query, and 12 "write a query for X" into an empty cell. Each runs through the same session code as live requests (`src/server/copilot/session.ts`), in a realistic notebook, with the error Postgres actually reports for the broken cell. A task passes when the proposed SQL's result matches the gold query's result. Column names and extra columns are ignored, row order matters only for rankings and time series, and numbers are compared at two decimals (`evals/score.ts`).

Three tasks are there because the offline model can't do them: `cost` meaning `price`, comparing a timestamp with a number, and a percentage. They keep the pass rate honest and show what a real model adds. The suite also caught a real bug: the planner grouped "top customers by spend" by name, and names in the sample data aren't unique.

CI runs the suite with the offline model and fails below 85%. `npm run evals -- --model openai` runs it against a real endpoint.

## Numbers

Measured on a 2-vCPU VM shared with other builds; Postgres, Redis and both server processes local.

| What | Result |
| --- | --- |
| Edit relay, one client to another on the same server process (500 single-character edits, each awaited) | p50 1.5–1.7 ms, p95 6–8 ms, p99 13–25 ms |
| Same, with the clients on two server processes (through Redis) | p50 0.8–1.5 ms, p95 4–6 ms, p99 13–27 ms |
| Two clients on two processes typing 1,000 characters concurrently | converged 1.0–2.0 s after the first keystroke |
| Compaction of 2,000 single-character updates | 2,000 rows / 39.7 KB → one 2.1 KB snapshot; load p50 6–29 ms → 0.6–1.5 ms |
| Evals, offline model | 22/25 (fix 11/13, write 11/12); about 2,650 prompt and 140 completion tokens per task |
| Context for "fix the broken cell" in the template notebook | about 380 of 2,980 budget tokens, all 8 candidates included |

The ranges come from repeated runs. The machine's load moves the tails more than the code does: on a quiet run the cross-process relay was no slower than the same-process one, because a Redis hop on localhost costs less than the scheduling noise. I haven't run the eval suite against a hosted model here (no API key in this environment), so there is no real-model pass rate, cost or latency to report. The harness records all three when one is configured.

## Tech stack

Node.js 22, TypeScript (strict, `noUncheckedIndexedAccess`), Yjs with y-protocols and the y-websocket client, `ws`, PostgreSQL 16 (`pg`, `pg-cursor`), Redis pub/sub (`ioredis`), graphql-yoga, zod, gpt-tokenizer, React 19, Vite, CodeMirror 6 with y-codemirror.next, Vitest, Playwright, GitHub Actions. The GIF is captured with Playwright from the running app and assembled with Pillow.

## Running it

Needs PostgreSQL 16 and Redis. Configuration comes from environment variables; `.env.example` lists them with their defaults. The setup script creates the app database, the sample database and its read-only role, so `ADMIN_DATABASE_URL` needs a role that can create databases and roles.

```bash
npm ci
npm run db:setup
npm run dev                     # server on :4710, web on http://localhost:5310
```

To see collaboration across processes, build the web app and start two servers sharing Postgres and Redis, then open one browser on each port:

```bash
npm run build
STATIC_DIR=dist PORT=4710 npm start
STATIC_DIR=dist PORT=4711 npm start
```

Add `?user=Ada` to the URL to choose a name. To use a hosted model, set `LLM_API_KEY` (and optionally `LLM_BASE_URL`, `LLM_MODEL`). Other settings:

| Variable | Default | |
| --- | --- | --- |
| `SQL_STATEMENT_TIMEOUT_MS` | `5000` | Per-statement timeout for cells |
| `SQL_ROW_LIMIT` | `500` | Rows stored per run |
| `COPILOT_CONTEXT_BUDGET` | `3000` | Tokens for notebook context |
| `COPILOT_MAX_STEPS` | `6` | Agent steps per request |
| `COPILOT_MAX_COST_USD` | `0.05` | Spend limit per request |
| `COLLAB_COMPACT_AFTER` | `200` | Update rows before compaction |

## Tests

```bash
npm run typecheck && npm run lint
npm test                        # 99 tests: 44 unit, 55 integration against real Postgres and Redis
npm run e2e                     # 4 Playwright tests, two browsers on two server processes
npm run evals                   # eval suite with the offline model; --model openai for a real one
npm run bench                   # relay latency and compaction numbers above
```

Integration tests create `dn_test_app` and `dn_test_sample` through `TEST_ADMIN_DATABASE_URL` (default `postgres://synckit:synckit@localhost:5432/postgres`). They include two real `node src/server/main.ts` processes with two clients typing into the same cell, offline edits merging on reconnect, a room opened late catching up on unpersisted state, and the copilot's fix reaching a client on the other server. If Playwright's own Chromium isn't installed, set `PLAYWRIGHT_CHROMIUM_PATH`.

The preview is regenerated with `npm run build && npx tsx scripts/capture-preview.ts && .venv/bin/python scripts/make_gif.py` (Pillow in `.venv`).

## Layout

```
src/shared/            notebook document model, proposals anchored to the CRDT, SSE GraphQL client
src/server/collab/     rooms, y-websocket protocol, Redis bus, Postgres persistence and compaction
src/server/exec/       read-only SQL runner, schema catalog, runs
src/server/graphql/    SDL and resolvers, including the streaming copilot subscription
src/server/copilot/    tokenizer, context builder, tools, agent loop, OpenAI-compatible and offline models
src/server/sample/     deterministic sample dataset and its read-only role
src/web/               React app: CodeMirror cells, results, presence, copilot panel
evals/                 tasks, execution-based scoring, harness and CLI
test/                  unit and integration tests, fakes (OpenAI-compatible server), helpers
e2e/                   Playwright tests
bench/                 sync and compaction benchmark
```

## Limitations

- No authentication or per-notebook permissions; anyone who can reach the server can open any notebook.
- Only SQL and Markdown cells. There is no Python or JavaScript execution.
- Run results are kept for every run; there is no retention policy yet.
- The context builder's relevance score is lexical (shared tables and terms). Embeddings would rank better on large notebooks, at the cost of an index to keep in sync with live edits.
- Token counts use o200k_base. Other model families tokenize differently, so for them the budget is close, not exact.

## License

MIT
