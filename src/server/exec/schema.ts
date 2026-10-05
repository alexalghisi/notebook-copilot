import type pg from "pg";

export interface ColumnSchema {
    name: string;
    type: string;
    nullable: boolean;
    comment: string | null;
}

export interface TableSchema {
    name: string;
    comment: string | null;
    rowEstimate: number;
    columns: ColumnSchema[];
}

export interface SchemaCatalog {
    tables(): Promise<TableSchema[]>;
}

/** Reads table and column metadata of the sample database, cached for `ttlMs`. */
export class PostgresSchemaCatalog implements SchemaCatalog {
    private cached: { at: number; tables: Promise<TableSchema[]> } | null = null;

    constructor(
        private readonly pool: pg.Pool,
        private readonly ttlMs = 60_000,
    ) {}

    tables(): Promise<TableSchema[]> {
        if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.tables;
        const tables = this.load();
        this.cached = { at: Date.now(), tables };
        tables.catch(() => {
            this.cached = null;
        });
        return tables;
    }

    private async load(): Promise<TableSchema[]> {
        const { rows } = await this.pool.query<{
            table_name: string;
            table_comment: string | null;
            row_estimate: number;
            column_name: string;
            data_type: string;
            is_nullable: string;
            column_comment: string | null;
        }>(`
            SELECT c.table_name, obj_description(cls.oid, 'pg_class') AS table_comment,
                   greatest(cls.reltuples, 0)::bigint AS row_estimate,
                   c.column_name, c.data_type, c.is_nullable,
                   col_description(cls.oid, c.ordinal_position::int) AS column_comment
            FROM information_schema.columns c
            JOIN pg_class cls ON cls.relname = c.table_name
            JOIN pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = c.table_schema
            WHERE c.table_schema = 'public'
            ORDER BY c.table_name, c.ordinal_position`);
        const tables = new Map<string, TableSchema>();
        for (const row of rows) {
            let table = tables.get(row.table_name);
            if (!table) {
                table = { name: row.table_name, comment: row.table_comment, rowEstimate: Number(row.row_estimate), columns: [] };
                tables.set(row.table_name, table);
            }
            table.columns.push({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === "YES", comment: row.column_comment });
        }
        return [...tables.values()];
    }
}
