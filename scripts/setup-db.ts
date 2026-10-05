import { ensureDatabase } from "../src/server/db/admin.ts";
import { migrate } from "../src/server/db/migrate.ts";
import { createPool } from "../src/server/db/pool.ts";
import { setupSampleDatabase } from "../src/server/sample/setup.ts";

const adminUrl = process.env.ADMIN_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/postgres";
const appDb = process.env.APP_DATABASE_NAME ?? "dn_app";
const sampleDb = process.env.SAMPLE_DATABASE_NAME ?? "dn_sample";

const appUrl = await ensureDatabase(adminUrl, appDb);
const pool = createPool(appUrl, 2);
const ran = await migrate(pool);
await pool.end();
console.log(`${appDb}: ${ran.length ? `applied ${ran.join(", ")}` : "up to date"}`);

await setupSampleDatabase({ adminUrl, database: sampleDb, readerRole: "dn_reader", readerPassword: "dn_reader" });
console.log(`${sampleDb}: sample data loaded, read-only role dn_reader`);
