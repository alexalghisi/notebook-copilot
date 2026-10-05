import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Redis } from "ioredis";

/**
 * Fan-out between server processes that have the same room open. Payloads are ordinary
 * y-protocols messages; `to` addresses a reply (sync step 2) to the process that asked.
 */
export interface BusMessage {
    from: string;
    to: string | null;
    payload: Uint8Array;
}

export type BusHandler = (message: BusMessage) => void;

export interface RoomBus {
    subscribe(room: string, handler: BusHandler): Promise<() => Promise<void>>;
    publish(room: string, message: BusMessage): Promise<void>;
    close(): Promise<void>;
}

export function encodeBusMessage(message: BusMessage): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, message.from);
    encoding.writeVarString(encoder, message.to ?? "");
    encoding.writeVarUint8Array(encoder, message.payload);
    return encoding.toUint8Array(encoder);
}

export function decodeBusMessage(data: Uint8Array): BusMessage {
    const decoder = decoding.createDecoder(data);
    const from = decoding.readVarString(decoder);
    const to = decoding.readVarString(decoder);
    const payload = decoding.readVarUint8Array(decoder);
    return { from, to: to === "" ? null : to, payload };
}

class Subscriptions {
    private readonly handlers = new Map<string, Set<BusHandler>>();

    add(channel: string, handler: BusHandler): boolean {
        let set = this.handlers.get(channel);
        const first = set === undefined;
        if (!set) this.handlers.set(channel, (set = new Set()));
        set.add(handler);
        return first;
    }

    remove(channel: string, handler: BusHandler): boolean {
        const set = this.handlers.get(channel);
        if (!set) return false;
        set.delete(handler);
        if (set.size > 0) return false;
        this.handlers.delete(channel);
        return true;
    }

    dispatch(channel: string, message: BusMessage): void {
        for (const handler of this.handlers.get(channel) ?? []) handler(message);
    }
}

export class RedisBus implements RoomBus {
    private readonly pub: Redis;
    private readonly sub: Redis;
    private readonly subscriptions = new Subscriptions();

    constructor(url: string, private readonly prefix = "dn:room:") {
        this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
        this.sub = new Redis(url, { lazyConnect: false });
        this.sub.on("messageBuffer", (channel: Buffer, data: Buffer) => {
            let message: BusMessage;
            try {
                message = decodeBusMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            } catch (error) {
                console.error("dropping malformed bus message:", (error as Error).message);
                return;
            }
            this.subscriptions.dispatch(channel.toString(), message);
        });
    }

    async subscribe(room: string, handler: BusHandler): Promise<() => Promise<void>> {
        const channel = this.prefix + room;
        if (this.subscriptions.add(channel, handler)) await this.sub.subscribe(channel);
        return async () => {
            if (this.subscriptions.remove(channel, handler)) await this.sub.unsubscribe(channel);
        };
    }

    async publish(room: string, message: BusMessage): Promise<void> {
        await this.pub.publish(this.prefix + room, Buffer.from(encodeBusMessage(message)));
    }

    async close(): Promise<void> {
        await Promise.all([this.pub.quit(), this.sub.quit()]);
    }
}

/** Same semantics as Redis pub/sub within one process; used by unit tests. */
export class MemoryBus implements RoomBus {
    private readonly subscriptions = new Subscriptions();

    async subscribe(room: string, handler: BusHandler): Promise<() => Promise<void>> {
        this.subscriptions.add(room, handler);
        return async () => {
            this.subscriptions.remove(room, handler);
        };
    }

    async publish(room: string, message: BusMessage): Promise<void> {
        // Copy and deliver asynchronously, like a network hop would.
        const copy = decodeBusMessage(encodeBusMessage(message));
        queueMicrotask(() => this.subscriptions.dispatch(room, copy));
    }

    async close(): Promise<void> {}
}
