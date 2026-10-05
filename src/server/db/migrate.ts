import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/** Applies pending `NNN_name.sql` files in order, each in its own transaction. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
    const applied = new Set((await pool.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((row) => row.name));
    const ran: string[] = [];
    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(sql);
            await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
            await client.query("COMMIT");
            ran.push(file);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
    return ran;
}
