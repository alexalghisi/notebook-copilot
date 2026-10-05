import { defineConfig } from "@playwright/test";

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const env = { OFFLINE_MODEL_DELAY_MS: "5", COLLAB_IDLE_UNLOAD_MS: "2000" };

// Two server processes behind different ports, sharing Postgres and Redis: each browser
// talks to a different process, so every test also exercises cross-process sync.
export default defineConfig({
    testDir: "e2e",
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 60_000,
    use: {
        trace: "retain-on-failure",
        viewport: { width: 1280, height: 860 },
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
    },
    webServer: [
        {
            command: "npm run build && STATIC_DIR=dist PORT=4720 npx tsx src/server/main.ts",
            url: "http://localhost:4720/healthz",
            env,
            reuseExistingServer: false,
            timeout: 120_000,
        },
        {
            command: "STATIC_DIR=dist PORT=4721 npx tsx src/server/main.ts",
            url: "http://localhost:4721/healthz",
            env,
            reuseExistingServer: false,
            timeout: 120_000,
        },
    ],
});
