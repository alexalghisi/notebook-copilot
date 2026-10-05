import { withDatabase } from "../../src/server/db/admin.ts";

export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/postgres";
export const APP_URL = withDatabase(ADMIN_URL, "dn_test_app");
export const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379";
