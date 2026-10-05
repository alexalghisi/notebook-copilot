import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { DocStore } from "../../src/server/collab/docStore.ts";
import { createPool } from "../../src/server/db/pool.ts";
import { NotebookRepo } from "../../src/server/notebooks.ts";
import { cellSource, findCell, readNotebook } from "../../src/shared/notebook.ts";
import { connectClient, type CollabClient } from "../helpers/collabClient.ts";
import { APP_URL, READER_URL, REDIS_URL } from "../helpers/env.ts";
import { startServerProcess, type ServerProcess } from "../helpers/serverProcess.ts";
import { waitFor } from "../helpers/waitFor.ts";

// Two real `node src/server/main.ts` processes sharing Postgres and Redis, as in production.
let servers: ServerProcess[] = [];
let pool: pg.Pool;

beforeAll(async () => {
    pool = createPool(APP_URL, 2);
    const env = { DATABASE_URL: APP_URL, SAMPLE_DATABASE_URL: READER_URL, REDIS_URL, COLLAB_FLUSH_DELAY_MS: "20" };
    servers = await Promise.all([startServerProcess(env), startServerProcess(env)]);
});

afterAll(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    await pool.end();
});

describe("two server processes", () => {
    it("converge when two clients type into the same cell at the same time", async () => {
        const repo = new NotebookRepo(pool, new DocStore(pool));
        const nb = await repo.create("two processes", [{ type: "sql", source: "" }]);
        const clients: CollabClient[] = [connectClient(servers[0]!.url, nb.id, "alice"), connectClient(servers[1]!.url, nb.id, "bob")];
        try {
            await Promise.all(clients.map((c) => c.synced()));
            const cellId = readNotebook(clients[0]!.doc).cells[0]!.id;
            const text = (c: CollabClient) => cellSource(findCell(c.doc, cellId)!).toString();

            // Interleave keystrokes from both clients without waiting for round trips.
            for (let i = 0; i < 40; i++) {
                for (const [n, c] of clients.entries()) {
                    const ytext = cellSource(findCell(c.doc, cellId)!);
                    ytext.insert(Math.floor(ytext.length / (n + 1)), n === 0 ? "a" : "b");
                }
                if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
            }

            await waitFor(() => text(clients[0]!) === text(clients[1]!) && text(clients[0]!).length === 80, { message: "convergence" });
            const final = text(clients[0]!);
            expect(final.split("a").length - 1).toBe(40);

            // And the persisted state agrees with what both clients see.
            await waitFor(async () => readNotebook(await new DocStore(pool).loadDoc(nb.id)).cells[0]!.source === final, {
                message: "persisted state to match",
            });
        } finally {
            clients.forEach((c) => c.destroy());
        }
    });
});
