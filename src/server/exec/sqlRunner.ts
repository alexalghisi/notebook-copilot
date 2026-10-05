import type pg from "pg";
import Cursor from "pg-cursor";

export interface ResultColumn {
    name: string;
    type: string;
}

export type CellValue = string | number | boolean | null | object;

export interface QueryResult {
    columns: ResultColumn[];
    rows: CellValue[][];
    rowCount: number;
    truncated: boolean;
    durationMs: number;
}

export class SqlError extends Error {
    constructor(
        message: string,
        readonly code: string | null,
        /** 1-based character offset into the statement, as Postgres reports it. */
        readonly position: number | null,
        readonly hint: string | null,
    ) {
        super(message);
        this.name = "SqlError";
    }
}

export interface QueryRunner {
    run(sql: string, options?: { rowLimit?: number }): Promise<QueryResult>;
}

const TYPE_NAMES: Record<number, string> = {
    16: "bool",
    20: "int8",
    21: "int2",
    23: "int4",
    25: "text",
    114: "json",
    700: "float4",
    701: "float8",
    1043: "varchar",
    1082: "date",
    1114: "timestamp",
    1184: "timestamptz",
    1700: "numeric",
    2950: "uuid",
    3802: "jsonb",
};

/**
 * Runs one statement from a SQL cell against the sample database.
 *
 * Each statement gets its own READ ONLY transaction with a local statement timeout and is
 * read through a cursor, so a `SELECT` over a huge table fetches `rowLimit + 1` rows and
 * stops instead of buffering everything. The +1 tells us whether the result was cut off.
 * Cursors use the extended protocol, which also rejects several statements in one cell.
 */
export class SqlRunner implements QueryRunner {
    constructor(
        private readonly pool: pg.Pool,
        private readonly options: { statementTimeoutMs: number; rowLimit: number },
    ) {}

    async run(sql: string, options: { rowLimit?: number } = {}): Promise<QueryResult> {
        const leading = sql.length - sql.trimStart().length;
        const statement = sql.trim().replace(/;\s*$/, "");
        if (stripComments(statement).trim() === "") throw new SqlError("The cell is empty.", null, null, null);
        const rowLimit = Math.min(options.rowLimit ?? this.options.rowLimit, this.options.rowLimit);
        const client = await this.pool.connect();
        const started = performance.now();
        try {
            await client.query("BEGIN READ ONLY");
            await client.query(`SET LOCAL statement_timeout = ${Math.trunc(this.options.statementTimeoutMs)}`);
            const cursor = client.query(new Cursor(statement, [], { rowMode: "array" }));
            const { rows, fields } = await new Promise<{ rows: unknown[][]; fields: pg.FieldDef[] }>((resolve, reject) => {
                cursor.read(rowLimit + 1, (error, rows, result) => {
                    if (error) reject(error);
                    else resolve({ rows: rows as unknown[][], fields: result.fields });
                });
            });
            await new Promise<void>((resolve) => cursor.close(() => resolve()));
            await client.query("ROLLBACK");
            const truncated = rows.length > rowLimit;
            const kept = truncated ? rows.slice(0, rowLimit) : rows;
            return {
                columns: fields.map((field) => ({ name: field.name, type: TYPE_NAMES[field.dataTypeID] ?? `oid:${field.dataTypeID}` })),
                rows: kept.map((row) => row.map(toCellValue)),
                rowCount: kept.length,
                truncated,
                durationMs: Math.round(performance.now() - started),
            };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw toSqlError(error, leading);
        } finally {
            client.release();
        }
    }
}

function toCellValue(value: unknown): CellValue {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "object") return value;
    return String(value);
}

function toSqlError(error: unknown, offset: number): SqlError {
    if (error instanceof SqlError) return error;
    const pgError = error as { message?: string; code?: string; position?: string; hint?: string };
    let message = pgError.message ?? String(error);
    if (pgError.code === "42601" && /multiple commands/.test(message)) message = "Only one statement per cell is supported.";
    if (pgError.code === "25006") message = `${message} (cells run in read-only transactions)`;
    if (pgError.code === "57014") message = "Query cancelled: it ran longer than the statement timeout.";
    const position = pgError.position ? Number.parseInt(pgError.position, 10) : null;
    return new SqlError(message, pgError.code ?? null, position !== null && Number.isFinite(position) ? position + offset : null, pgError.hint ?? null);
}

function stripComments(sql: string): string {
    return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
