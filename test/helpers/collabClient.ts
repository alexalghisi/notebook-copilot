import { WebSocket } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { waitFor } from "./waitFor.ts";

export interface CollabClient {
    doc: Y.Doc;
    provider: WebsocketProvider;
    synced(): Promise<void>;
    destroy(): void;
}

/** A browser-equivalent client: the same y-websocket provider the web app uses, over `ws`. */
export function connectClient(baseUrl: string, notebookId: string, user = "test"): CollabClient {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`${baseUrl.replace(/^http/, "ws")}/collab`, notebookId, doc, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        disableBc: true,
    });
    provider.awareness.setLocalStateField("user", { name: user });
    return {
        doc,
        provider,
        synced: () => waitFor(() => provider.synced, { message: `${user} to sync` }),
        destroy() {
            provider.destroy();
            doc.destroy();
        },
    };
}
