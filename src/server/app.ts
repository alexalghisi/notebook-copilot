import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type pg from "pg";
import { RedisBus, type RoomBus } from "./collab/bus.ts";
import { DocStore } from "./collab/docStore.ts";
import { RoomManager } from "./collab/roomManager.ts";
import { attachCollab } from "./collab/wsServer.ts";
import type { Config } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { RunService } from "./exec/runService.ts";
import { PostgresSchemaCatalog, type SchemaCatalog } from "./exec/schema.ts";
import { SqlRunner } from "./exec/sqlRunner.ts";
import { CopilotService } from "./copilot/copilotService.ts";
import type { ChatModel } from "./copilot/model.ts";
import { OfflineModel } from "./copilot/offline/offlineModel.ts";
import { OpenAIModel } from "./copilot/openaiModel.ts";
import { priceFor } from "./copilot/pricing.ts";
import { createGraphQL } from "./graphql/yoga.ts";
import { NotebookRepo } from "./notebooks.ts";
import { staticHandler } from "./static.ts";

export interface App {
    server: Server;
    serverId: string;
    rooms: RoomManager;
    notebooks: NotebookRepo;
    runs: RunService;
    sqlRunner: SqlRunner;
    schema: SchemaCatalog;
    copilot: CopilotService;
    listen(port: number): Promise<number>;
    close(): Promise<void>;
}

export interface AppDeps {
    pool?: pg.Pool;
    samplePool?: pg.Pool;
    bus?: RoomBus;
    model?: ChatModel;
}

export function createApp(config: Config, deps: AppDeps = {}): App {
    const serverId = randomUUID();
    const pool = deps.pool ?? createPool(config.databaseUrl);
    const samplePool = deps.samplePool ?? createPool(config.sampleDatabaseUrl, 8);
    const bus = deps.bus ?? new RedisBus(config.redisUrl);
    const store = new DocStore(pool);
    const notebooks = new NotebookRepo(pool, store);
    const rooms = new RoomManager({
        serverId,
        store,
        bus,
        flushDelayMs: config.collab.flushDelayMs,
        compactAfterUpdates: config.collab.compactAfterUpdates,
        idleUnloadMs: config.collab.idleUnloadMs,
        peerSyncTimeoutMs: 150,
    });
    const sqlRunner = new SqlRunner(samplePool, config.sql);
    const schema = new PostgresSchemaCatalog(samplePool);
    const runs = new RunService(pool, rooms, sqlRunner);
    const model =
        deps.model ??
        (config.llm ? new OpenAIModel({ baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, model: config.llm.model }) : new OfflineModel({ chunkDelayMs: config.copilot.offlineDelayMs }));
    const copilot = new CopilotService({
        pool,
        rooms,
        schema,
        runner: sqlRunner,
        runs,
        model,
        price: priceFor(model.name),
        contextBudget: config.copilot.contextBudget,
        limits: { maxSteps: config.copilot.maxSteps, maxCostUsd: config.copilot.maxCostUsd },
    });

    const yoga = createGraphQL({ notebooks, runs, rooms, schema, copilot });
    const serveStatic = config.staticDir ? staticHandler(config.staticDir) : null;

    const server = createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
            console.error("request failed:", error);
            if (!res.headersSent) res.writeHead(500).end();
        });
    });
    const collab = attachCollab(server, rooms, store);

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/healthz") {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, serverId, rooms: rooms.openRooms }));
            return;
        }
        if (url.pathname.startsWith("/graphql")) {
            await yoga.handle(req, res);
            return;
        }
        if (serveStatic && (await serveStatic(req, res))) return;
        res.writeHead(404).end();
    }

    return {
        server,
        serverId,
        rooms,
        notebooks,
        runs,
        sqlRunner,
        schema,
        copilot,
        listen(port) {
            return new Promise((resolve) => {
                server.listen(port, () => {
                    const address = server.address();
                    resolve(typeof address === "object" && address ? address.port : port);
                });
            });
        },
        async close() {
            await collab.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rooms.closeAll();
            if (!deps.bus) await bus.close();
            if (!deps.pool) await pool.end();
            if (!deps.samplePool) await samplePool.end();
        },
    };
}
