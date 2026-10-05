export interface LlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface Config {
    port: number;
    databaseUrl: string;
    sampleDatabaseUrl: string;
    redisUrl: string;
    /** Serve the built web app from this directory, if set. */
    staticDir: string | null;
    llm: LlmConfig | null;
    sql: { statementTimeoutMs: number; rowLimit: number };
    collab: { flushDelayMs: number; compactAfterUpdates: number; idleUnloadMs: number };
}

function int(value: string | undefined, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) throw new Error(`expected an integer, got ${value}`);
    return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const apiKey = env.LLM_API_KEY ?? "";
    return {
        port: int(env.PORT, 4710),
        databaseUrl: env.DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/dn_app",
        sampleDatabaseUrl: env.SAMPLE_DATABASE_URL ?? "postgres://dn_reader:dn_reader@localhost:5432/dn_sample",
        redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
        staticDir: env.STATIC_DIR ?? null,
        llm: apiKey
            ? {
                  baseUrl: env.LLM_BASE_URL ?? "https://api.openai.com/v1",
                  apiKey,
                  model: env.LLM_MODEL ?? "gpt-4o-mini",
              }
            : null,
        sql: {
            statementTimeoutMs: int(env.SQL_STATEMENT_TIMEOUT_MS, 5_000),
            rowLimit: int(env.SQL_ROW_LIMIT, 500),
        },
        collab: {
            flushDelayMs: int(env.COLLAB_FLUSH_DELAY_MS, 50),
            compactAfterUpdates: int(env.COLLAB_COMPACT_AFTER, 200),
            idleUnloadMs: int(env.COLLAB_IDLE_UNLOAD_MS, 10_000),
        },
    };
}
