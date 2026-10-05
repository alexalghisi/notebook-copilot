import { ensureDatabase } from "../src/server/db/admin.ts";
import { migrate } from "../src/server/db/migrate.ts";
import { createPool } from "../src/server/db/pool.ts";

const adminUrl = process.env.ADMIN_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/postgres";
const appDb = process.env.APP_DATABASE_NAME ?? "dn_app";

const appUrl = await ensureDatabase(adminUrl, appDb);
const pool = createPool(appUrl, 2);
const ran = await migrate(pool);
await pool.end();
console.log(`${appDb}: ${ran.length ? `applied ${ran.join(", ")}` : "up to date"}`);
