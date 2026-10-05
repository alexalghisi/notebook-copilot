import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { BusMessage, RoomBus } from "./bus.ts";
import type { DocStore } from "./docStore.ts";

// Message types of the y-websocket wire protocol, which the browser provider speaks.
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

/** Transaction origins. Anything else (a Peer, SERVER_ORIGIN) is a local change. */
export const BUS_ORIGIN = Symbol("bus");
export const STORE_ORIGIN = Symbol("store");
export const SERVER_ORIGIN = Symbol("server");

export interface Peer {
    send(data: Uint8Array): void;
    close(): void;
}

export interface RoomOptions {
    serverId: string;
    store: DocStore;
    bus: RoomBus;
    flushDelayMs: number;
    compactAfterUpdates: number;
    /** How long a freshly opened room waits for other processes to report state they haven't persisted yet. */
    peerSyncTimeoutMs: number;
    log?: (message: string) => void;
}

/**
 * One notebook document held in memory by one server process.
 *
 * Changes reach the room from three places: websocket peers on this process, other
 * processes via the bus, and server-side code (run results, accepted edits). Each change
 * is applied once to the local Y.Doc; the update handler then fans it out to local peers,
 * publishes it on the bus unless it came from there, and queues it for Postgres only when
 * this process is where it entered the system.
 */
export class Room {
    readonly doc = new Y.Doc();
    readonly awareness = new awarenessProtocol.Awareness(this.doc);
    private readonly peers = new Map<Peer, Set<number>>();
    private unsubscribe: (() => Promise<void>) | null = null;
    private pending: Uint8Array[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private persistChain: Promise<void> = Promise.resolve();
    private rowsSinceCompaction = 0;
    private resolvePeerSync: (() => void) | null = null;
    /** Resolves once another process has answered our sync request, or after the timeout. */
    readonly peerSync: Promise<void>;
    private closed = false;

    private constructor(
        readonly id: string,
        private readonly options: RoomOptions,
    ) {
        this.awareness.setLocalState(null);
        this.peerSync = new Promise<void>((resolve) => {
            this.resolvePeerSync = resolve;
        });
        this.doc.on("update", this.onDocUpdate);
        this.awareness.on("update", this.onAwarenessUpdate);
    }

    static async open(id: string, options: RoomOptions): Promise<Room> {
        const room = new Room(id, options);
        await room.start();
        return room;
    }

    get peerCount(): number {
        return this.peers.size;
    }

    private async start(): Promise<void> {
        // Subscribe before loading so nothing published during the load is missed.
        this.unsubscribe = await this.options.bus.subscribe(this.id, (message) => this.onBusMessage(message));
        const stored = await this.options.store.load(this.id);
        this.doc.transact(() => stored.updates.forEach((update) => Y.applyUpdate(this.doc, update)), STORE_ORIGIN);
        this.rowsSinceCompaction = stored.pendingUpdateRows;

        const step1 = encoding.createEncoder();
        encoding.writeVarUint(step1, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(step1, this.doc);
        await this.publish(encoding.toUint8Array(step1), null);
        await this.publish(encoding.toUint8Array(messageOf(MESSAGE_QUERY_AWARENESS)), null);
        setTimeout(() => this.resolvePeerSync?.(), this.options.peerSyncTimeoutMs).unref();
    }

    addPeer(peer: Peer): void {
        this.peers.set(peer, new Set());
        const step1 = encoding.createEncoder();
        encoding.writeVarUint(step1, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(step1, this.doc);
        peer.send(encoding.toUint8Array(step1));
        const states = [...this.awareness.getStates().keys()];
        if (states.length > 0) peer.send(this.awarenessMessage(states));
    }

    removePeer(peer: Peer): void {
        const controlled = this.peers.get(peer);
        this.peers.delete(peer);
        if (controlled && controlled.size > 0) awarenessProtocol.removeAwarenessStates(this.awareness, [...controlled], null);
    }

    handlePeerMessage(peer: Peer, data: Uint8Array): void {
        try {
            const decoder = decoding.createDecoder(data);
            const type = decoding.readVarUint(decoder);
            switch (type) {
                case MESSAGE_SYNC: {
                    const encoder = messageOf(MESSAGE_SYNC);
                    syncProtocol.readSyncMessage(decoder, encoder, this.doc, peer);
                    if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder));
                    break;
                }
                case MESSAGE_AWARENESS:
                    awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), peer);
                    break;
                case MESSAGE_QUERY_AWARENESS:
                    peer.send(this.awarenessMessage([...this.awareness.getStates().keys()]));
                    break;
                default:
                    // Auth and other message types aren't used; ignoring them keeps old clients working.
                    break;
            }
        } catch (error) {
            this.log(`closing peer after malformed message: ${(error as Error).message}`);
            peer.close();
        }
    }

    /** Applies a server-side change (run output, accepted copilot edit) as a local edit. */
    transact(fn: (doc: Y.Doc) => void): void {
        this.doc.transact(() => fn(this.doc), SERVER_ORIGIN);
    }

    /** Persists everything queued so far; resolves when it's in Postgres. */
    async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.persistChain = this.persistChain.then(() => this.persistPending());
        await this.persistChain;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.flush();
        if (this.rowsSinceCompaction > 0) await this.compact();
        await this.unsubscribe?.();
        for (const peer of this.peers.keys()) peer.close();
        this.peers.clear();
        this.awareness.destroy();
        this.doc.destroy();
    }

    private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
        const encoder = messageOf(MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        const message = encoding.toUint8Array(encoder);
        for (const peer of this.peers.keys()) {
            if (peer !== origin) peer.send(message);
        }
        if (origin === BUS_ORIGIN || origin === STORE_ORIGIN) return;
        void this.publish(message, null);
        this.enqueue(update);
    };

    private readonly onAwarenessUpdate = (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
    ): void => {
        const controlled = this.peers.get(origin as Peer);
        if (controlled) {
            added.forEach((id) => controlled.add(id));
            removed.forEach((id) => controlled.delete(id));
        }
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        const message = this.awarenessMessage(changed);
        for (const peer of this.peers.keys()) peer.send(message);
        if (origin !== BUS_ORIGIN) void this.publish(message, null);
    };

    private onBusMessage(message: BusMessage): void {
        if (this.closed || message.from === this.options.serverId) return;
        if (message.to !== null && message.to !== this.options.serverId) return;
        try {
            const decoder = decoding.createDecoder(message.payload);
            const type = decoding.readVarUint(decoder);
            if (type === MESSAGE_SYNC) {
                const reply = messageOf(MESSAGE_SYNC);
                const syncType = syncProtocol.readSyncMessage(decoder, reply, this.doc, BUS_ORIGIN);
                if (encoding.length(reply) > 1) void this.publish(encoding.toUint8Array(reply), message.from);
                if (syncType === syncProtocol.messageYjsSyncStep2 && message.to === this.options.serverId) this.resolvePeerSync?.();
            } else if (type === MESSAGE_AWARENESS) {
                awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), BUS_ORIGIN);
            } else if (type === MESSAGE_QUERY_AWARENESS) {
                const local = [...this.peers.values()].flatMap((ids) => [...ids]);
                if (local.length > 0) void this.publish(this.awarenessMessage(local), message.from);
            }
        } catch (error) {
            this.log(`ignoring malformed bus message: ${(error as Error).message}`);
        }
    }

    private awarenessMessage(clients: number[]): Uint8Array {
        const encoder = messageOf(MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
        return encoding.toUint8Array(encoder);
    }

    private async publish(payload: Uint8Array, to: string | null): Promise<void> {
        try {
            await this.options.bus.publish(this.id, { from: this.options.serverId, to, payload });
        } catch (error) {
            // Peers on other processes catch up through their own sync on reconnect, and the
            // update is still persisted, so a failed publish degrades latency, not correctness.
            this.log(`bus publish failed: ${(error as Error).message}`);
        }
    }

    private enqueue(update: Uint8Array): void {
        this.pending.push(update);
        if (this.flushTimer === null && !this.closed) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.persistChain = this.persistChain.then(() => this.persistPending());
            }, this.options.flushDelayMs);
        }
    }

    private async persistPending(): Promise<void> {
        if (this.pending.length === 0) return;
        const batch = this.pending;
        this.pending = [];
        try {
            await this.options.store.append(this.id, Y.mergeUpdates(batch));
        } catch (error) {
            this.log(`persisting ${batch.length} update(s) failed, will retry: ${(error as Error).message}`);
            this.pending = [...batch, ...this.pending];
            if (!this.closed) this.flushTimer ??= setTimeout(() => void this.flush(), 1_000);
            return;
        }
        this.rowsSinceCompaction += 1;
        if (this.rowsSinceCompaction >= this.options.compactAfterUpdates) await this.compact();
    }

    private async compact(): Promise<void> {
        try {
            const result = await this.options.store.compact(this.id);
            if (result.compacted) this.rowsSinceCompaction = 0;
        } catch (error) {
            this.log(`compaction failed: ${(error as Error).message}`);
        }
    }

    private log(message: string): void {
        (this.options.log ?? console.warn)(`[room ${this.id}] ${message}`);
    }
}

function messageOf(type: number): encoding.Encoder {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, type);
    return encoder;
}
