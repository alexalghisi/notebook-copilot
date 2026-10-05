import type pg from "pg";
import { cellSource, cellType, findCell, outputsOf, type OutputSummary, type RunStatus } from "../../shared/notebook.ts";
import type { RoomManager } from "../collab/roomManager.ts";
import { SqlError, type QueryRunner, type ResultColumn, type CellValue } from "./sqlRunner.ts";

export interface Run {
    id: string;
    notebookId: string;
    cellId: string;
    source: string;
    status: RunStatus;
    columns: ResultColumn[];
    rows: CellValue[][];
    rowCount: number | null;
    truncated: boolean;
    error: string | null;
    errorPosition: number | null;
    durationMs: number | null;
    startedAt: Date;
    finishedAt: Date | null;
}

export class RunError extends Error {}

interface RunRow {
    id: string;
    notebook_id: string;
    cell_id: string;
    source: string;
    status: RunStatus;
    columns: ResultColumn[] | null;
    rows: CellValue[][] | null;
    row_count: number | null;
    truncated: boolean;
    error: string | null;
    error_position: number | null;
    duration_ms: number | null;
    started_at: Date;
    finished_at: Date | null;
}

/**
 * Executes SQL cells. The source is read from the live document, not from the request,
 * so a run always reflects what collaborators see. The result is stored once in Postgres;
 * the document only gets a summary pointing at the run, which every collaborator receives
 * through the normal sync path.
 */
export class RunService {
    constructor(
        private readonly pool: pg.Pool,
        private readonly rooms: RoomManager,
        private readonly runner: QueryRunner,
    ) {}

    async runCell(notebookId: string, cellId: string): Promise<Run> {
        const room = await this.rooms.acquire(notebookId);
        try {
            await room.peerSync;
            const cell = findCell(room.doc, cellId);
            if (!cell) throw new RunError(`cell ${cellId} not found`);
            if (cellType(cell) !== "sql") throw new RunError("only SQL cells can be run");
            const source = cellSource(cell).toString();

            const { rows } = await this.pool.query<{ id: string; started_at: Date }>(
                `INSERT INTO runs (notebook_id, cell_id, source, status) VALUES ($1, $2, $3, 'running') RETURNING id, started_at`,
                [notebookId, cellId, source],
            );
            const runId = rows[0]!.id;
            room.transact((doc) => outputsOf(doc).set(cellId, summary(runId, "running")));

            let finished: OutputSummary;
            try {
                const result = await this.runner.run(source);
                await this.pool.query(
                    `UPDATE runs SET status = 'succeeded', columns = $2, rows = $3, row_count = $4, truncated = $5,
                         duration_ms = $6, finished_at = now() WHERE id = $1`,
                    [runId, JSON.stringify(result.columns), JSON.stringify(result.rows), result.rowCount, result.truncated, result.durationMs],
                );
                finished = { ...summary(runId, "succeeded"), rowCount: result.rowCount, durationMs: result.durationMs };
            } catch (error) {
                const sqlError = error instanceof SqlError ? error : new SqlError((error as Error).message, null, null, null);
                const message = sqlError.hint ? `${sqlError.message}\nHint: ${sqlError.hint}` : sqlError.message;
                await this.pool.query(
                    `UPDATE runs SET status = 'failed', error = $2, error_position = $3, finished_at = now(),
                         duration_ms = round(extract(epoch FROM now() - started_at) * 1000) WHERE id = $1`,
                    [runId, message, sqlError.position],
                );
                finished = { ...summary(runId, "failed"), error: message };
            }
            finished.finishedAt = new Date().toISOString();
            // A slower, older run must not overwrite the output of a newer one, and a
            // deleted cell must not get its output back.
            room.transact((doc) => {
                if (findCell(doc, cellId) && outputsOf(doc).get(cellId)?.runId === runId) outputsOf(doc).set(cellId, finished);
            });
            const run = await this.get(runId);
            if (!run) throw new RunError("run disappeared");
            return run;
        } finally {
            this.rooms.release(notebookId);
        }
    }

    async get(runId: string): Promise<Run | null> {
        const { rows } = await this.pool.query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [runId]);
        return rows[0] ? toRun(rows[0]) : null;
    }

    async latestForCell(notebookId: string, cellId: string): Promise<Run | null> {
        const { rows } = await this.pool.query<RunRow>(
            `SELECT * FROM runs WHERE notebook_id = $1 AND cell_id = $2 ORDER BY started_at DESC LIMIT 1`,
            [notebookId, cellId],
        );
        return rows[0] ? toRun(rows[0]) : null;
    }

    async listForNotebook(notebookId: string, limit = 50): Promise<Run[]> {
        const { rows } = await this.pool.query<RunRow>(
            `SELECT * FROM runs WHERE notebook_id = $1 ORDER BY started_at DESC LIMIT $2`,
            [notebookId, Math.min(limit, 200)],
        );
        return rows.map(toRun);
    }
}

function summary(runId: string, status: RunStatus): OutputSummary {
    return { runId, status, rowCount: null, error: null, durationMs: null, finishedAt: null };
}

function toRun(row: RunRow): Run {
    return {
        id: row.id,
        notebookId: row.notebook_id,
        cellId: row.cell_id,
        source: row.source,
        status: row.status,
        columns: row.columns ?? [],
        rows: row.rows ?? [],
        rowCount: row.row_count,
        truncated: row.truncated,
        error: row.error,
        errorPosition: row.error_position,
        durationMs: row.duration_ms,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}
