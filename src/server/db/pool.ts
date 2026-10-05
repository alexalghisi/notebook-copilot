import pg from "pg";

// bigint counts (COUNT(*), bigserial ids) fit comfortably in a JS number at this scale.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export function createPool(connectionString: string, max = 10): pg.Pool {
    const pool = new pg.Pool({ connectionString, max });
    // An idle client losing its connection must not crash the process.
    pool.on("error", (error) => console.error("postgres pool error:", error.message));
    return pool;
}
