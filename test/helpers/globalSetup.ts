import { ensureDatabase } from "../../src/server/db/admin.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { createPool } from "../../src/server/db/pool.ts";
import { ADMIN_URL } from "./env.ts";

export default async function setup(): Promise<void> {
    const appUrl = await ensureDatabase(ADMIN_URL, "dn_test_app", { recreate: true });
    const pool = createPool(appUrl, 2);
    await migrate(pool);
    await pool.end();
}
