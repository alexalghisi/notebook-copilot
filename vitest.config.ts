import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        globalSetup: ["test/helpers/globalSetup.ts"],
        // Integration tests spawn server processes and share one Redis; running files
        // one at a time keeps their timing stable on a small machine.
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
