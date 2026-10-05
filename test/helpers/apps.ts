import { createApp, type App } from "../../src/server/app.ts";
import { loadConfig, type Config } from "../../src/server/config.ts";
import { APP_URL, READER_URL, REDIS_URL } from "./env.ts";

export function testConfig(overrides: Partial<Config["collab"]> = {}): Config {
    const config = loadConfig({ DATABASE_URL: APP_URL, SAMPLE_DATABASE_URL: READER_URL, REDIS_URL });
    return {
        ...config,
        collab: { flushDelayMs: 10, compactAfterUpdates: 200, idleUnloadMs: 100, ...overrides },
        copilot: { ...config.copilot, offlineDelayMs: 0 },
    };
}

/** Starts an app on an ephemeral port; each call is a separate "server process" with its own Redis connections. */
export async function startApp(config: Config = testConfig()): Promise<App & { url: string }> {
    const app = createApp(config);
    const port = await app.listen(0);
    return Object.assign(app, { url: `http://localhost:${port}` });
}
