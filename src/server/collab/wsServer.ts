import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DocStore } from "./docStore.ts";
import type { Peer } from "./room.ts";
import type { RoomManager } from "./roomManager.ts";

const PATH = /^\/collab\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?.*)?$/;
const PING_INTERVAL_MS = 30_000;

export interface CollabServer {
    close(): Promise<void>;
}

/** Serves `ws(s)://host/collab/<notebookId>` with the y-websocket protocol. */
export function attachCollab(server: Server, rooms: RoomManager, store: DocStore): CollabServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const notebookId = PATH.exec(request.url ?? "")?.[1];
        if (!notebookId) {
            reject(socket, 404, "Not Found");
            return;
        }
        store.exists(notebookId).then(
            (exists) => {
                if (!exists) reject(socket, 404, "Not Found");
                else wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, notebookId, rooms));
            },
            () => reject(socket, 503, "Service Unavailable"),
        );
    });

    const heartbeat = setInterval(() => {
        for (const client of wss.clients) {
            const alive = client as WebSocket & { alive?: boolean };
            if (alive.alive === false) {
                client.terminate();
                continue;
            }
            alive.alive = false;
            client.ping();
        }
    }, PING_INTERVAL_MS);
    heartbeat.unref();

    return {
        async close() {
            clearInterval(heartbeat);
            for (const client of wss.clients) client.terminate();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
        },
    };
}

function handleConnection(ws: WebSocket, notebookId: string, rooms: RoomManager): void {
    ws.binaryType = "nodebuffer";
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on("pong", () => {
        (ws as WebSocket & { alive?: boolean }).alive = true;
    });

    const peer: Peer = {
        send(data) {
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        close() {
            ws.close();
        },
    };
    // Messages that arrive while the room is loading are replayed once it's ready.
    const queued: Uint8Array[] = [];
    let onMessage: (data: Uint8Array) => void = (data) => {
        queued.push(data);
    };
    let closed = false;
    let release: (() => void) | null = null;

    ws.on("message", (data: RawData) => onMessage(toUint8(data)));
    ws.on("close", () => {
        closed = true;
        release?.();
    });

    rooms.acquire(notebookId).then(
        (room) => {
            release = () => {
                room.removePeer(peer);
                rooms.release(notebookId);
            };
            if (closed) {
                release();
                return;
            }
            room.addPeer(peer);
            onMessage = (data) => room.handlePeerMessage(peer, data);
            queued.splice(0).forEach(onMessage);
        },
        (error: unknown) => {
            console.error(`opening room ${notebookId} failed:`, error);
            ws.close(1011, "room unavailable");
        },
    );
}

function toUint8(data: RawData): Uint8Array {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function reject(socket: Duplex, status: number, text: string): void {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
