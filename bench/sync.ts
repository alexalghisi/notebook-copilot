/**
 * Measures what collaborators feel: how long an edit takes to show up for someone else,
 * on the same server process and across two processes (through Redis), plus what
 * compaction does to the stored log and to load time.
 *
 *   npm run bench            (needs `npm run db:setup`, Postgres and Redis)
 */
import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { DocStore } from "../src/server/collab/docStore.ts";
import { createPool } from "../src/server/db/pool.ts";
import { NotebookRepo } from "../src/server/notebooks.ts";
import { cellSource, findCell, readNotebook } from "../src/shared/notebook.ts";
import { startServerProcess } from "../test/helpers/serverProcess.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/dn_app";
const EDITS = Number(process.env.BENCH_EDITS ?? 500);

function client(url: string, notebookId: string) {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`${url.replace(/^http/, "ws")}/collab`, notebookId, doc, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        disableBc: true,
    });
    return { doc, provider };
}

async function synced(provider: WebsocketProvider): Promise<void> {
    while (!provider.synced) await new Promise((resolve) => setTimeout(resolve, 10));
}

function percentile(sorted: number[], p: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function summary(samples: number[]): string {
    const sorted = [...samples].sort((a, b) => a - b);
    return `p50 ${percentile(sorted, 0.5).toFixed(2)} ms, p95 ${percentile(sorted, 0.95).toFixed(2)} ms, p99 ${percentile(sorted, 0.99).toFixed(2)} ms`;
}

/** Inserts one character on `from` and waits until `to` has it, EDITS times. */
async function relayLatency(fromUrl: string, toUrl: string, repo: NotebookRepo): Promise<number[]> {
    const nb = await repo.create("bench", [{ type: "sql", source: "" }]);
    const a = client(fromUrl, nb.id);
    const b = client(toUrl, nb.id);
    await Promise.all([synced(a.provider), synced(b.provider)]);
    const cellId = readNotebook(a.doc).cells[0]!.id;
    const textA = cellSource(findCell(a.doc, cellId)!);
    const textB = cellSource(findCell(b.doc, cellId)!);
    const samples: number[] = [];
    for (let i = 0; i < EDITS; i++) {
        const target = textA.length + 1;
        const seen = new Promise<void>((resolve) => {
            const check = () => {
                if (textB.length >= target) {
                    textB.unobserve(check);
                    resolve();
                }
            };
            textB.observe(check);
        });
        const started = performance.now();
        textA.insert(textA.length, "x");
        await seen;
        samples.push(performance.now() - started);
    }
    for (const c of [a, b]) {
        c.provider.destroy();
        c.doc.destroy();
    }
    return samples;
}

/** Two clients on different processes type concurrently; time until both documents agree. */
async function concurrentConvergence(urlA: string, urlB: string, repo: NotebookRepo): Promise<{ ms: number; length: number }> {
    const nb = await repo.create("bench-concurrent", [{ type: "sql", source: "" }]);
    const a = client(urlA, nb.id);
    const b = client(urlB, nb.id);
    await Promise.all([synced(a.provider), synced(b.provider)]);
    const cellId = readNotebook(a.doc).cells[0]!.id;
    const ta = cellSource(findCell(a.doc, cellId)!);
    const tb = cellSource(findCell(b.doc, cellId)!);
    const started = performance.now();
    for (let i = 0; i < EDITS; i++) {
        ta.insert(Math.floor(ta.length / 2), "a");
        tb.insert(tb.length, "b");
        if (i % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    while (!(ta.length === 2 * EDITS && tb.toString() === ta.toString())) await new Promise((resolve) => setTimeout(resolve, 2));
    const ms = performance.now() - started;
    for (const c of [a, b]) {
        c.provider.destroy();
        c.doc.destroy();
    }
    return { ms, length: ta.length };
}

async function compaction(pool: ReturnType<typeof createPool>, repo: NotebookRepo, store: DocStore): Promise<void> {
    const nb = await repo.create("bench-compaction", [{ type: "sql", source: "" }]);
    const doc = await store.loadDoc(nb.id);
    const text = cellSource(findCell(doc, readNotebook(doc).cells[0]!.id)!);
    for (let i = 0; i < 2_000; i++) {
        const before = Y.encodeStateVector(doc);
        text.insert(text.length, String(i % 10));
        await store.append(nb.id, Y.encodeStateAsUpdate(doc, before));
    }
    const bytes = async () =>
        (await pool.query<{ rows: number; bytes: number }>(`SELECT count(*) AS rows, coalesce(sum(length(update)), 0)::int AS bytes FROM doc_updates WHERE notebook_id = $1`, [nb.id])).rows[0]!;
    const time = async () => {
        const runs: number[] = [];
        for (let i = 0; i < 20; i++) {
            const started = performance.now();
            (await store.loadDoc(nb.id)).destroy();
            runs.push(performance.now() - started);
        }
        return percentile(runs.sort((x, y) => x - y), 0.5);
    };
    const before = await bytes();
    const loadBefore = await time();
    const result = await store.compact(nb.id);
    const loadAfter = await time();
    console.log(
        `compaction: ${before.rows} update rows (${before.bytes} bytes) -> snapshot of ${result.snapshotBytes} bytes; ` +
            `load p50 ${loadBefore.toFixed(1)} ms -> ${loadAfter.toFixed(1)} ms`,
    );
}

const pool = createPool(DATABASE_URL, 4);
const store = new DocStore(pool);
const repo = new NotebookRepo(pool, store);
const env = { DATABASE_URL, COLLAB_FLUSH_DELAY_MS: "50" };
const [one, two] = await Promise.all([startServerProcess(env), startServerProcess(env)]);
try {
    console.log(`${EDITS} single-character edits, each awaited before the next (2 vCPU VM, everything local)`);
    console.log(`same server:      ${summary(await relayLatency(one.url, one.url, repo))}`);
    console.log(`across servers:   ${summary(await relayLatency(one.url, two.url, repo))}`);
    const concurrent = await concurrentConvergence(one.url, two.url, repo);
    console.log(`concurrent:       ${2 * EDITS} edits from two clients on two servers converged in ${concurrent.ms.toFixed(0)} ms`);
    await compaction(pool, repo, store);
} finally {
    await Promise.all([one.stop(), two.stop()]);
    await pool.end();
}
