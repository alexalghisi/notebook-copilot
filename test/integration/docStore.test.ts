import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import * as Y from "yjs";
import { DocStore } from "../../src/server/collab/docStore.ts";
import { createPool } from "../../src/server/db/pool.ts";
import { NotebookRepo } from "../../src/server/notebooks.ts";
import { cellSource, cellsOf, readNotebook } from "../../src/shared/notebook.ts";
import { APP_URL } from "../helpers/env.ts";

let pool: pg.Pool;
let store: DocStore;
let repo: NotebookRepo;

beforeAll(() => {
    pool = createPool(APP_URL, 6);
    store = new DocStore(pool);
    repo = new NotebookRepo(pool, store);
});
afterAll(() => pool.end());

async function editAndAppend(base: Y.Doc, notebookId: string, text: string): Promise<void> {
    const before = Y.encodeStateVector(base);
    cellSource(cellsOf(base).get(0)).insert(cellSource(cellsOf(base).get(0)).length, text);
    await store.append(notebookId, Y.encodeStateAsUpdate(base, before));
}

async function updateRows(notebookId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*) AS n FROM doc_updates WHERE notebook_id = $1`, [notebookId]);
    return rows[0]!.n;
}

describe("DocStore", () => {
    it("loads the initial snapshot plus appended updates", async () => {
        const nb = await repo.create("store", [{ type: "sql", source: "select" }]);
        const local = await store.loadDoc(nb.id);
        await editAndAppend(local, nb.id, " 1");
        await editAndAppend(local, nb.id, " + 1");

        const loaded = await store.loadDoc(nb.id);
        expect(readNotebook(loaded).cells[0]!.source).toBe("select 1 + 1");
        expect(await updateRows(nb.id)).toBe(2);
    });

    it("compacts updates into the snapshot without changing the document", async () => {
        const nb = await repo.create("compact", [{ type: "sql", source: "" }]);
        const local = await store.loadDoc(nb.id);
        for (let i = 0; i < 50; i++) await editAndAppend(local, nb.id, `${i % 10}`);
        const before = readNotebook(await store.loadDoc(nb.id));

        const result = await store.compact(nb.id);
        expect(result).toMatchObject({ compacted: true, mergedRows: 50 });
        expect(await updateRows(nb.id)).toBe(0);
        expect(readNotebook(await store.loadDoc(nb.id))).toEqual(before);

        expect((await store.compact(nb.id)).compacted).toBe(false);
    });

    it("never loses updates appended while compactions run concurrently", async () => {
        const nb = await repo.create("race", [{ type: "sql", source: "" }]);
        const writers = Array.from({ length: 4 }, async (_, w) => {
            const doc = await store.loadDoc(nb.id);
            for (let i = 0; i < 15; i++) {
                await editAndAppend(doc, nb.id, String.fromCharCode(97 + w));
                if (i % 5 === 0) await store.compact(nb.id);
            }
        });
        await Promise.all([...writers, store.compact(nb.id), store.compact(nb.id)]);
        await store.compact(nb.id);

        const source = readNotebook(await store.loadDoc(nb.id)).cells[0]!.source;
        expect(source).toHaveLength(60);
        for (const letter of "abcd") expect(source.split(letter).length - 1).toBe(15);
    });
});
