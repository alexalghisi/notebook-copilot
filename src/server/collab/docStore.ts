import type pg from "pg";
import * as Y from "yjs";

export interface StoredDoc {
    /** Snapshot first (if any), then update rows in insertion order. */
    updates: Uint8Array[];
    pendingUpdateRows: number;
}

export interface CompactionResult {
    compacted: boolean;
    mergedRows: number;
    snapshotBytes: number;
}

/**
 * Postgres persistence for notebook documents: an append-only log of Yjs updates plus
 * one snapshot per notebook. Yjs updates are idempotent and commutative, so loading is
 * "apply everything", and compaction can run in any process at any time.
 */
export class DocStore {
    constructor(private readonly pool: pg.Pool) {}

    async exists(notebookId: string): Promise<boolean> {
        const { rowCount } = await this.pool.query(`SELECT 1 FROM notebooks WHERE id = $1`, [notebookId]);
        return rowCount === 1;
    }

    async load(notebookId: string): Promise<StoredDoc> {
        const snapshot = await this.pool.query<{ state: Buffer }>(`SELECT state FROM doc_snapshots WHERE notebook_id = $1`, [notebookId]);
        const rows = await this.pool.query<{ update: Buffer }>(`SELECT update FROM doc_updates WHERE notebook_id = $1 ORDER BY id`, [notebookId]);
        const updates = [...snapshot.rows.map((row) => row.state), ...rows.rows.map((row) => row.update)].map(toUint8);
        return { updates, pendingUpdateRows: rows.rowCount ?? 0 };
    }

    async loadDoc(notebookId: string): Promise<Y.Doc> {
        const doc = new Y.Doc();
        const { updates } = await this.load(notebookId);
        doc.transact(() => updates.forEach((update) => Y.applyUpdate(doc, update)));
        return doc;
    }

    async append(notebookId: string, update: Uint8Array): Promise<void> {
        await this.pool.query(`INSERT INTO doc_updates (notebook_id, update) VALUES ($1, $2)`, [notebookId, Buffer.from(update)]);
    }

    async writeSnapshot(notebookId: string, state: Uint8Array): Promise<void> {
        await this.pool.query(
            `INSERT INTO doc_snapshots (notebook_id, state) VALUES ($1, $2)
             ON CONFLICT (notebook_id) DO UPDATE SET state = EXCLUDED.state, compacted_at = now()`,
            [notebookId, Buffer.from(state)],
        );
    }

    /**
     * Folds the snapshot and all visible update rows into a new snapshot and deletes exactly
     * the rows that were folded in. A per-notebook advisory lock keeps two processes from
     * compacting the same notebook at once; the loser simply skips.
     */
    async compact(notebookId: string): Promise<CompactionResult> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext('dn:doc:' || $1)) AS locked`, [
                notebookId,
            ]);
            if (!lock.rows[0]?.locked) {
                await client.query("ROLLBACK");
                return { compacted: false, mergedRows: 0, snapshotBytes: 0 };
            }
            const snapshot = await client.query<{ state: Buffer }>(`SELECT state FROM doc_snapshots WHERE notebook_id = $1`, [notebookId]);
            const rows = await client.query<{ id: number; update: Buffer }>(
                `SELECT id, update FROM doc_updates WHERE notebook_id = $1 ORDER BY id`,
                [notebookId],
            );
            if (rows.rows.length === 0) {
                await client.query("ROLLBACK");
                return { compacted: false, mergedRows: 0, snapshotBytes: snapshot.rows[0]?.state.length ?? 0 };
            }
            const doc = new Y.Doc();
            doc.transact(() => {
                for (const row of snapshot.rows) Y.applyUpdate(doc, toUint8(row.state));
                for (const row of rows.rows) Y.applyUpdate(doc, toUint8(row.update));
            });
            const state = Y.encodeStateAsUpdate(doc);
            doc.destroy();
            await client.query(
                `INSERT INTO doc_snapshots (notebook_id, state, updates_merged) VALUES ($1, $2, $3)
                 ON CONFLICT (notebook_id) DO UPDATE
                 SET state = EXCLUDED.state, updates_merged = doc_snapshots.updates_merged + EXCLUDED.updates_merged, compacted_at = now()`,
                [notebookId, Buffer.from(state), rows.rows.length],
            );
            await client.query(`DELETE FROM doc_updates WHERE id = ANY($1::bigint[])`, [rows.rows.map((row) => row.id)]);
            await client.query("COMMIT");
            return { compacted: true, mergedRows: rows.rows.length, snapshotBytes: state.length };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}

function toUint8(buffer: Buffer): Uint8Array {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
