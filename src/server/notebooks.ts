import type pg from "pg";
import * as Y from "yjs";
import { initNotebook, type CellType } from "../shared/notebook.ts";
import type { DocStore } from "./collab/docStore.ts";

export interface NotebookRow {
    id: string;
    title: string;
    createdAt: Date;
}

export class NotebookRepo {
    constructor(
        private readonly pool: pg.Pool,
        private readonly store: DocStore,
    ) {}

    /** Creates the notebook row and its initial document as a snapshot, before anyone can connect. */
    async create(title: string, cells: ReadonlyArray<{ type: CellType; source: string }> = []): Promise<NotebookRow> {
        const { rows } = await this.pool.query<{ id: string; title: string; created_at: Date }>(
            `INSERT INTO notebooks (title) VALUES ($1) RETURNING id, title, created_at`,
            [title],
        );
        const row = rows[0];
        if (!row) throw new Error("insert returned no row");
        const doc = new Y.Doc();
        initNotebook(doc, title, cells);
        await this.store.writeSnapshot(row.id, Y.encodeStateAsUpdate(doc));
        doc.destroy();
        return { id: row.id, title: row.title, createdAt: row.created_at };
    }

    async list(): Promise<NotebookRow[]> {
        const { rows } = await this.pool.query<{ id: string; title: string; created_at: Date }>(
            `SELECT id, title, created_at FROM notebooks ORDER BY created_at DESC LIMIT 100`,
        );
        return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at }));
    }

    async get(id: string): Promise<NotebookRow | null> {
        if (!isUuid(id)) return null;
        const { rows } = await this.pool.query<{ id: string; title: string; created_at: Date }>(
            `SELECT id, title, created_at FROM notebooks WHERE id = $1`,
            [id],
        );
        const row = rows[0];
        return row ? { id: row.id, title: row.title, createdAt: row.created_at } : null;
    }
}

export function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
