import pg from "pg";

function withDatabase(url: string, database: string): string {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    return parsed.toString();
}

function quoteIdent(name: string): string {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing unusual identifier ${name}`);
    return `"${name}"`;
}

/** Creates `database` if it doesn't exist (or drops and recreates it) and returns its URL. */
export async function ensureDatabase(adminUrl: string, database: string, options: { recreate?: boolean } = {}): Promise<string> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
        if (options.recreate) await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
        const { rowCount } = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [database]);
        if (rowCount === 0) await client.query(`CREATE DATABASE ${quoteIdent(database)}`);
    } finally {
        await client.end();
    }
    return withDatabase(adminUrl, database);
}

export { quoteIdent, withDatabase };
