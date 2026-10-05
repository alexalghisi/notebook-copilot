import pg from "pg";
import { ensureDatabase, quoteIdent } from "../db/admin.ts";
import { loadSampleData } from "./dataset.ts";

export interface SampleSetup {
    adminUrl: string;
    database: string;
    readerRole: string;
    readerPassword: string;
    recreate?: boolean;
}

/**
 * Creates the sample database and the role SQL cells run as. The role can only read:
 * SELECT on the sample tables, no CREATE or TEMP, and read-only transactions by default.
 * The executor still opens every transaction READ ONLY with its own timeout; the role is
 * the second line of defence, not the only one.
 */
export async function setupSampleDatabase(options: SampleSetup): Promise<string> {
    const url = await ensureDatabase(options.adminUrl, options.database, { recreate: options.recreate ?? false });
    const role = quoteIdent(options.readerRole);
    const db = quoteIdent(options.database);

    const admin = new pg.Client({ connectionString: options.adminUrl });
    await admin.connect();
    try {
        const exists = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [options.readerRole]);
        const password = `'${options.readerPassword.replaceAll("'", "''")}'`;
        if (exists.rowCount === 0) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${password}`);
        await admin.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
        await admin.query(`ALTER ROLE ${role} SET statement_timeout = '10s'`);
        await admin.query(`ALTER ROLE ${role} SET timezone = 'UTC'`);
        await admin.query(`ALTER ROLE ${role} CONNECTION LIMIT 40`);
    } finally {
        await admin.end();
    }

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
        const loaded = await client.query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'orders'`);
        if (loaded.rowCount === 0) await loadSampleData(client);
        await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
        await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
        await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
        await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
        await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    } finally {
        await client.end();
    }
    return url;
}
