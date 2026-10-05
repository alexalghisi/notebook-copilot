import { useEffect, useState, useSyncExternalStore } from "react";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { cellsOf, metaOf, outputsOf, type CellMap, type OutputSummary } from "../shared/notebook.ts";

export interface User {
    name: string;
    color: string;
    colorLight: string;
}

const COLORS = ["#d81b60", "#1e88e5", "#43a047", "#fb8c00", "#8e24aa", "#00897b", "#6d4c41", "#3949ab"];
const NAMES = ["Ada", "Grace", "Edsger", "Barbara", "Ken", "Margaret", "Donald", "Frances"];

function hash(text: string): number {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h);
}

/** Name from `?user=`, else remembered in this browser, else picked at random. */
export function currentUser(): User {
    const fromUrl = new URLSearchParams(location.search).get("user");
    let name = fromUrl ?? "";
    if (!name) {
        try {
            name = localStorage.getItem("nb-user") ?? "";
        } catch {
            // storage can be unavailable (private mode); a random name per load is fine
        }
    }
    if (!name) {
        name = NAMES[Math.floor(Math.random() * NAMES.length)]!;
        try {
            localStorage.setItem("nb-user", name);
        } catch {
            // see above
        }
    }
    const color = COLORS[hash(name) % COLORS.length]!;
    return { name, color, colorLight: `${color}33` };
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface Collab {
    doc: Y.Doc;
    provider: WebsocketProvider;
}

/** Connects a Y.Doc to the notebook's room; edits made while offline sync on reconnect. */
export function useCollab(notebookId: string, user: User): Collab | null {
    const [collab, setCollab] = useState<Collab | null>(null);
    useEffect(() => {
        const doc = new Y.Doc();
        const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;
        const provider = new WebsocketProvider(url, notebookId, doc);
        provider.awareness.setLocalStateField("user", user);
        // The doc and provider live exactly as long as this effect; state is how the tree gets them.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setCollab({ doc, provider });
        return () => {
            provider.destroy();
            doc.destroy();
            setCollab(null);
        };
    }, [notebookId, user]);
    return collab;
}

function useYValue<T>(subscribe: (onChange: () => void) => () => void, read: () => T): T {
    return useSyncExternalStore(subscribe, read);
}

export function useStatus(provider: WebsocketProvider): { status: ConnectionStatus; synced: boolean } {
    const status = useYValue(
        (onChange) => {
            provider.on("status", onChange);
            return () => provider.off("status", onChange);
        },
        () => (provider.wsconnected ? "connected" : provider.wsconnecting ? "connecting" : "disconnected") as ConnectionStatus,
    );
    const synced = useYValue(
        (onChange) => {
            provider.on("sync", onChange);
            return () => provider.off("sync", onChange);
        },
        () => provider.synced,
    );
    return { status, synced };
}

/** The cell list; re-renders when cells are added, removed or moved, not on every keystroke. */
export function useCells(doc: Y.Doc): CellMap[] {
    const cells = cellsOf(doc);
    const [snapshot, setSnapshot] = useState(() => cells.toArray());
    useEffect(() => {
        const update = () => setSnapshot(cells.toArray());
        update();
        cells.observe(update);
        return () => cells.unobserve(update);
    }, [cells]);
    return snapshot;
}

export function useOutput(doc: Y.Doc, cellId: string): OutputSummary | undefined {
    const outputs = outputsOf(doc);
    return useYValue(
        (onChange) => {
            const handler = (event: Y.YMapEvent<OutputSummary>) => {
                if (event.keysChanged.has(cellId)) onChange();
            };
            outputs.observe(handler);
            return () => outputs.unobserve(handler);
        },
        () => outputs.get(cellId),
    );
}

export function useTitle(doc: Y.Doc): string {
    const meta = metaOf(doc);
    return useYValue(
        (onChange) => {
            meta.observe(onChange);
            return () => meta.unobserve(onChange);
        },
        () => meta.get("title") ?? "Untitled",
    );
}

export interface Peer {
    clientId: number;
    user: User;
    isSelf: boolean;
}

export function usePeers(provider: WebsocketProvider): Peer[] {
    const awareness = provider.awareness;
    const [peers, setPeers] = useState<Peer[]>([]);
    useEffect(() => {
        const update = () => {
            const list: Peer[] = [];
            awareness.getStates().forEach((state, clientId) => {
                const user = (state as { user?: User }).user;
                if (user) list.push({ clientId, user, isSelf: clientId === awareness.clientID });
            });
            setPeers(list.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.clientId - b.clientId));
        };
        update();
        awareness.on("change", update);
        return () => awareness.off("change", update);
    }, [awareness]);
    return peers;
}
