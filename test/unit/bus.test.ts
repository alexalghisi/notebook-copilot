import { describe, expect, it } from "vitest";
import { MemoryBus, decodeBusMessage, encodeBusMessage } from "../../src/server/collab/bus.ts";

describe("bus messages", () => {
    it("round-trips sender, addressee and payload", () => {
        const message = { from: "a", to: "b", payload: new Uint8Array([0, 1, 255]) };
        expect(decodeBusMessage(encodeBusMessage(message))).toEqual(message);
        const broadcast = { from: "a", to: null, payload: new Uint8Array() };
        expect(decodeBusMessage(encodeBusMessage(broadcast))).toEqual(broadcast);
    });

    it("rejects truncated input instead of returning garbage", () => {
        const bytes = encodeBusMessage({ from: "server-a", to: null, payload: new Uint8Array([1, 2, 3]) });
        expect(() => decodeBusMessage(bytes.slice(0, 5))).toThrow();
    });

    it("delivers to every subscriber of a room until they unsubscribe", async () => {
        const bus = new MemoryBus();
        const seen: string[] = [];
        const off = await bus.subscribe("r", (m) => seen.push(`1:${m.from}`));
        await bus.subscribe("r", (m) => seen.push(`2:${m.from}`));
        await bus.subscribe("other", (m) => seen.push(`x:${m.from}`));
        await bus.publish("r", { from: "a", to: null, payload: new Uint8Array() });
        await Promise.resolve();
        await off();
        await bus.publish("r", { from: "b", to: null, payload: new Uint8Array() });
        await Promise.resolve();
        expect(seen).toEqual(["1:a", "2:a", "2:b"]);
    });
});
