import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.API_URL ?? "http://localhost:4710";

export default defineConfig({
    plugins: [react()],
    // Two copies of Yjs in one bundle break `instanceof` checks between the editor binding and the provider.
    resolve: { dedupe: ["yjs"] },
    server: {
        port: 5310,
        proxy: {
            "/graphql": { target: api, changeOrigin: true },
            "/collab": { target: api.replace(/^http/, "ws"), ws: true },
        },
    },
    build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1200 },
});
