import { ensureDatabase } from "../../src/server/db/admin.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { createPool } from "../../src/server/db/pool.ts";
import { setupSampleDatabase } from "../../src/server/sample/setup.ts";
import { ADMIN_URL, SAMPLE_DB } from "./env.ts";

export default async function setup(): Promise<void> {
    const appUrl = await ensureDatabase(ADMIN_URL, "dn_test_app", { recreate: true });
    const pool = createPool(appUrl, 2);
    await migrate(pool);
    await pool.end();
    // The sample data is deterministic and read-only, so it is only built once.
    await setupSampleDatabase({ adminUrl: ADMIN_URL, database: SAMPLE_DB, readerRole: "dn_reader", readerPassword: "dn_reader" });
}
