import * as Y from "yjs";

/**
 * The shape of a notebook inside its Y.Doc. Everything collaborators edit lives here:
 * the ordered cells (each with a Y.Text source, so concurrent typing in one cell merges)
 * and a small summary of each cell's latest run. Result rows are deliberately not in the
 * document: they are stored once per run in Postgres and fetched on demand, so the CRDT
 * history doesn't grow with every query result.
 */
export type CellType = "sql" | "markdown";

export const CELL_TYPES: readonly CellType[] = ["sql", "markdown"];

export type RunStatus = "running" | "succeeded" | "failed";

export interface OutputSummary {
    runId: string;
    status: RunStatus;
    rowCount: number | null;
    error: string | null;
    durationMs: number | null;
    finishedAt: string | null;
}

export interface CellSnapshot {
    id: string;
    type: CellType;
    source: string;
    output: OutputSummary | null;
}

export interface NotebookSnapshot {
    title: string;
    cells: CellSnapshot[];
}

export type CellMap = Y.Map<unknown>;

export function cellsOf(doc: Y.Doc): Y.Array<CellMap> {
    return doc.getArray<CellMap>("cells");
}

export function outputsOf(doc: Y.Doc): Y.Map<OutputSummary> {
    return doc.getMap<OutputSummary>("outputs");
}

export function metaOf(doc: Y.Doc): Y.Map<string> {
    return doc.getMap<string>("meta");
}

export function newCellId(): string {
    return globalThis.crypto.randomUUID().slice(0, 8);
}

export function createCell(type: CellType, source = "", id: string = newCellId()): CellMap {
    const cell = new Y.Map<unknown>();
    cell.set("id", id);
    cell.set("type", type);
    cell.set("source", new Y.Text(source));
    return cell;
}

export function cellId(cell: CellMap): string {
    const id = cell.get("id");
    if (typeof id !== "string") throw new Error("cell without id");
    return id;
}

export function cellType(cell: CellMap): CellType {
    const type = cell.get("type");
    return type === "markdown" ? "markdown" : "sql";
}

export function cellSource(cell: CellMap): Y.Text {
    const source = cell.get("source");
    if (!(source instanceof Y.Text)) throw new Error(`cell ${cellId(cell)} has no source text`);
    return source;
}

export function findCell(doc: Y.Doc, id: string): CellMap | undefined {
    for (const cell of cellsOf(doc)) {
        if (cell.get("id") === id) return cell;
    }
    return undefined;
}

export function findCellIndex(doc: Y.Doc, id: string): number {
    return cellsOf(doc).toArray().findIndex((cell) => cell.get("id") === id);
}

export function insertCell(doc: Y.Doc, index: number, type: CellType, source = ""): string {
    const cell = createCell(type, source);
    const cells = cellsOf(doc);
    cells.insert(Math.max(0, Math.min(index, cells.length)), [cell]);
    return cellId(cell);
}

export function deleteCell(doc: Y.Doc, id: string): boolean {
    const index = findCellIndex(doc, id);
    if (index < 0) return false;
    doc.transact(() => {
        cellsOf(doc).delete(index, 1);
        outputsOf(doc).delete(id);
    });
    return true;
}

export function initNotebook(doc: Y.Doc, title: string, cells: ReadonlyArray<{ type: CellType; source: string }>): void {
    doc.transact(() => {
        metaOf(doc).set("title", title);
        cellsOf(doc).push(cells.map((cell) => createCell(cell.type, cell.source)));
    });
}

export function readNotebook(doc: Y.Doc): NotebookSnapshot {
    const outputs = outputsOf(doc);
    return {
        title: metaOf(doc).get("title") ?? "Untitled",
        cells: cellsOf(doc)
            .toArray()
            .map((cell) => {
                const id = cellId(cell);
                return { id, type: cellType(cell), source: cellSource(cell).toString(), output: outputs.get(id) ?? null };
            }),
    };
}
