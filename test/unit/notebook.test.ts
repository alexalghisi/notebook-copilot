import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { cellSource, cellsOf, deleteCell, findCell, initNotebook, insertCell, outputsOf, readNotebook } from "../../src/shared/notebook.ts";

function sync(a: Y.Doc, b: Y.Doc): void {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe("notebook document", () => {
    it("reads back the cells it was initialised with", () => {
        const doc = new Y.Doc();
        initNotebook(doc, "Orders", [
            { type: "markdown", source: "# Orders" },
            { type: "sql", source: "select 1" },
        ]);
        const snapshot = readNotebook(doc);
        expect(snapshot.title).toBe("Orders");
        expect(snapshot.cells.map((cell) => [cell.type, cell.source, cell.output])).toEqual([
            ["markdown", "# Orders", null],
            ["sql", "select 1", null],
        ]);
    });

    it("merges concurrent typing in the same cell from two replicas", () => {
        const a = new Y.Doc();
        initNotebook(a, "t", [{ type: "sql", source: "select  from orders" }]);
        const b = new Y.Doc();
        sync(a, b);
        const id = readNotebook(a).cells[0]!.id;

        cellSource(findCell(a, id)!).insert(7, "id");
        cellSource(findCell(b, id)!).insert(19, " limit 5");
        sync(a, b);

        expect(readNotebook(a).cells[0]!.source).toBe("select id from orders limit 5");
        expect(readNotebook(b)).toEqual(readNotebook(a));
    });

    it("keeps both cells when two replicas insert at the same position", () => {
        const a = new Y.Doc();
        initNotebook(a, "t", []);
        const b = new Y.Doc();
        sync(a, b);
        insertCell(a, 0, "sql", "from a");
        insertCell(b, 0, "sql", "from b");
        sync(a, b);
        expect(cellsOf(a).length).toBe(2);
        expect(readNotebook(a)).toEqual(readNotebook(b));
    });

    it("drops the output summary together with the cell", () => {
        const doc = new Y.Doc();
        initNotebook(doc, "t", [{ type: "sql", source: "select 1" }]);
        const id = readNotebook(doc).cells[0]!.id;
        outputsOf(doc).set(id, { runId: "r1", status: "succeeded", rowCount: 1, error: null, durationMs: 3, finishedAt: null });
        expect(deleteCell(doc, id)).toBe(true);
        expect(outputsOf(doc).size).toBe(0);
        expect(deleteCell(doc, id)).toBe(false);
    });
});
