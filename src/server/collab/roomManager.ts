import { Room, type RoomOptions } from "./room.ts";

interface Entry {
    room: Promise<Room>;
    holds: number;
    idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Keeps at most one Room per notebook in this process. Websocket connections and server
 * operations hold a room while they use it; a room nobody holds is persisted, compacted
 * and dropped after `idleUnloadMs`. A room that is still closing is awaited before the
 * same notebook is opened again, so the new instance loads the final flush.
 */
export class RoomManager {
    private readonly entries = new Map<string, Entry>();
    private readonly closing = new Map<string, Promise<void>>();

    constructor(private readonly options: RoomOptions & { idleUnloadMs: number }) {}

    get openRooms(): number {
        return this.entries.size;
    }

    async acquire(id: string): Promise<Room> {
        let entry = this.entries.get(id);
        if (!entry) {
            const pendingClose = this.closing.get(id);
            const room = (pendingClose ?? Promise.resolve()).then(() => Room.open(id, this.options));
            entry = { room, holds: 0, idleTimer: null };
            this.entries.set(id, entry);
            room.catch(() => {
                if (this.entries.get(id) === entry) this.entries.delete(id);
            });
        }
        entry.holds += 1;
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
        try {
            return await entry.room;
        } catch (error) {
            entry.holds -= 1;
            throw error;
        }
    }

    release(id: string): void {
        const entry = this.entries.get(id);
        if (!entry) return;
        entry.holds -= 1;
        if (entry.holds > 0) return;
        entry.idleTimer = setTimeout(() => {
            if (this.entries.get(id) !== entry || entry.holds > 0) return;
            this.entries.delete(id);
            this.closeEntry(id, entry);
        }, this.options.idleUnloadMs);
    }

    /** Runs `fn` against an up-to-date room: one that has heard back from other processes holding it. */
    async withRoom<T>(id: string, fn: (room: Room) => T | Promise<T>): Promise<T> {
        const room = await this.acquire(id);
        try {
            await room.peerSync;
            return await fn(room);
        } finally {
            this.release(id);
        }
    }

    async closeAll(): Promise<void> {
        const entries = [...this.entries];
        this.entries.clear();
        for (const [id, entry] of entries) {
            if (entry.idleTimer) clearTimeout(entry.idleTimer);
            this.closeEntry(id, entry);
        }
        await Promise.all(this.closing.values());
    }

    private closeEntry(id: string, entry: Entry): void {
        const done = entry.room
            .then((room) => room.close())
            .catch((error: unknown) => console.error(`closing room ${id} failed:`, error))
            .finally(() => {
                if (this.closing.get(id) === done) this.closing.delete(id);
            });
        this.closing.set(id, done);
    }
}
