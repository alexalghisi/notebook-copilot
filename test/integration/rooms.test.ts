import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { App } from "../../src/server/app.ts";
import { DocStore } from "../../src/server/collab/docStore.ts";
import { createPool } from "../../src/server/db/pool.ts";
import { cellSource, findCell, insertCell, outputsOf, readNotebook } from "../../src/shared/notebook.ts";
import { startApp, testConfig } from "../helpers/apps.ts";
import { connectClient, type CollabClient } from "../helpers/collabClient.ts";
import { APP_URL } from "../helpers/env.ts";
import { waitFor } from "../helpers/waitFor.ts";

const apps: App[] = [];
const clients: CollabClient[] = [];

afterEach(async () => {
    clients.splice(0).forEach((client) => client.destroy());
    await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function twoServers(config = testConfig()) {
    const a = await startApp(config);
    const b = await startApp(config);
    apps.push(a, b);
    return [a, b] as const;
}

function client(url: string, notebookId: string, name: string): CollabClient {
    const c = connectClient(url, notebookId, name);
    clients.push(c);
    return c;
}

function source(c: CollabClient, cellId: string): string {
    const cell = findCell(c.doc, cellId);
    return cell ? cellSource(cell).toString() : "";
}

describe("rooms across server processes", () => {
    it("relays edits between clients connected to different servers", async () => {
        const [a, b] = await twoServers();
        const nb = await a.notebooks.create("relay", [{ type: "sql", source: "select 1" }]);
        const alice = client(a.url, nb.id, "alice");
        const bob = client(b.url, nb.id, "bob");
        await Promise.all([alice.synced(), bob.synced()]);
        const cellId = readNotebook(alice.doc).cells[0]!.id;

        cellSource(findCell(alice.doc, cellId)!).insert(8, "0");
        await waitFor(() => source(bob, cellId) === "select 10", { message: "bob to see alice's edit" });
        insertCell(bob.doc, 1, "markdown", "notes");
        await waitFor(() => readNotebook(alice.doc).cells.length === 2, { message: "alice to see bob's cell" });
    });

    it("shares presence across servers and clears it when a client leaves", async () => {
        const [a, b] = await twoServers();
        const nb = await a.notebooks.create("presence", []);
        const alice = client(a.url, nb.id, "alice");
        const bob = client(b.url, nb.id, "bob");
        await Promise.all([alice.synced(), bob.synced()]);

        const names = (c: CollabClient) =>
            [...c.provider.awareness.getStates().values()].map((s) => (s.user as { name: string } | undefined)?.name).sort();
        await waitFor(() => names(alice).join() === "alice,bob", { message: "alice to see bob" });

        bob.provider.disconnect();
        await waitFor(() => names(alice).join() === "alice", { message: "bob's presence to be removed" });
    });

    it("merges edits made while a client was offline", async () => {
        const [a, b] = await twoServers();
        const nb = await a.notebooks.create("offline", [{ type: "sql", source: "select * from orders" }]);
        const alice = client(a.url, nb.id, "alice");
        const bob = client(b.url, nb.id, "bob");
        await Promise.all([alice.synced(), bob.synced()]);
        const cellId = readNotebook(alice.doc).cells[0]!.id;

        bob.provider.disconnect();
        cellSource(findCell(bob.doc, cellId)!).insert(20, " limit 10");
        cellSource(findCell(alice.doc, cellId)!).insert(0, "-- top orders\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(source(alice, cellId)).not.toContain("limit");

        bob.provider.connect();
        const expected = "-- top orders\nselect * from orders limit 10";
        await waitFor(() => source(alice, cellId) === expected && source(bob, cellId) === expected, { message: "convergence" });
    });

    it("persists edits so a fresh server loads them after every server stopped", async () => {
        const [a] = await twoServers();
        const nb = await a.notebooks.create("persist", [{ type: "sql", source: "" }]);
        const alice = client(a.url, nb.id, "alice");
        await alice.synced();
        const cellId = readNotebook(alice.doc).cells[0]!.id;
        for (const ch of "select 42") cellSource(findCell(alice.doc, cellId)!).insert(source(alice, cellId).length, ch);
        await waitFor(async () => (await a.rooms.withRoom(nb.id, (room) => readNotebook(room.doc).cells[0]!.source)) === "select 42");
        alice.destroy();
        await Promise.all(apps.splice(0).map((app) => app.close()));

        const [c] = await twoServers();
        const carol = client(c.url, nb.id, "carol");
        await carol.synced();
        expect(source(carol, cellId)).toBe("select 42");
    });

    it("compacts the update log once it grows past the threshold", async () => {
        const [a] = await twoServers(testConfig({ compactAfterUpdates: 5, flushDelayMs: 0 }));
        const nb = await a.notebooks.create("compaction", [{ type: "sql", source: "" }]);
        const alice = client(a.url, nb.id, "alice");
        await alice.synced();
        const cellId = readNotebook(alice.doc).cells[0]!.id;
        for (let i = 0; i < 12; i++) {
            cellSource(findCell(alice.doc, cellId)!).insert(i, "x");
            await new Promise((resolve) => setTimeout(resolve, 15));
        }
        const pool = createPool(APP_URL, 1);
        try {
            await waitFor(async () => {
                const { rows } = await pool.query<{ merged: number }>(`SELECT updates_merged AS merged FROM doc_snapshots WHERE notebook_id = $1`, [nb.id]);
                return (rows[0]?.merged ?? 0) >= 5;
            }, { message: "a compaction" });
            const store = new DocStore(pool);
            await waitFor(async () => readNotebook(await store.loadDoc(nb.id)).cells[0]!.source === "x".repeat(12), {
                message: "the compacted state to hold every edit",
            });
        } finally {
            await pool.end();
        }
    });

    it("propagates server-side changes to clients on every server", async () => {
        const [a, b] = await twoServers();
        const nb = await a.notebooks.create("server-writes", [{ type: "sql", source: "select 1" }]);
        const bob = client(b.url, nb.id, "bob");
        await bob.synced();
        const cellId = readNotebook(bob.doc).cells[0]!.id;

        await a.rooms.withRoom(nb.id, (room) =>
            room.transact((doc) => outputsOf(doc).set(cellId, { runId: "r", status: "succeeded", rowCount: 1, error: null, durationMs: 1, finishedAt: null })),
        );
        await waitFor(() => outputsOf(bob.doc).get(cellId)?.status === "succeeded", { message: "bob to see the output" });
    });

    it("lets a server that opens a room late catch up on state not yet persisted", async () => {
        const [a, b] = await twoServers(testConfig({ flushDelayMs: 60_000 }));
        const nb = await a.notebooks.create("late", [{ type: "sql", source: "" }]);
        const alice = client(a.url, nb.id, "alice");
        await alice.synced();
        const cellId = readNotebook(alice.doc).cells[0]!.id;
        cellSource(findCell(alice.doc, cellId)!).insert(0, "unsaved");
        await waitFor(async () => (await a.rooms.withRoom(nb.id, (room) => readNotebook(room.doc).cells[0]!.source)) === "unsaved");

        const seen = await b.rooms.withRoom(nb.id, (room) => readNotebook(room.doc).cells[0]!.source);
        expect(seen).toBe("unsaved");
    });

    it("rejects connections to notebooks that don't exist", async () => {
        const [a] = await twoServers();
        const ghost = client(a.url, "00000000-0000-4000-8000-000000000000", "ghost");
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(ghost.provider.wsconnected).toBe(false);
        expect(Y.encodeStateVector(ghost.doc).length).toBeLessThanOrEqual(1);
    });
});
