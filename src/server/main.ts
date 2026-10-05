import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = createApp(config);
const port = await app.listen(config.port);
console.log(`notebook server ${app.serverId.slice(0, 8)} listening on http://localhost:${port}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: flushing rooms and shutting down`);
    await app.close();
    process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
