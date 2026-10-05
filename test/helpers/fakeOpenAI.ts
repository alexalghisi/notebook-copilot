import { createServer, type IncomingMessage, type Server } from "node:http";

/** One scripted reply of the fake chat completions server. */
export type FakeReply =
    | { kind: "stream"; chunks: unknown[]; delayMs?: number; done?: boolean; dropAfter?: number }
    | { kind: "raw"; body: string }
    | { kind: "error"; status: number; body?: unknown; headers?: Record<string, string> }
    | { kind: "hang" };

export interface FakeOpenAI {
    url: string;
    requests: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }>;
    enqueue(...replies: FakeReply[]): void;
    close(): Promise<void>;
}

/** Builders for the chunk shapes OpenAI-compatible servers send. */
export const chunk = {
    text: (content: string) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }),
    toolStart: (index: number, id: string, name: string) => ({
        choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
    }),
    toolArgs: (index: number, args: string) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] }, finish_reason: null }] }),
    finish: (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }),
    usage: (prompt: number, completion: number) => ({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } }),
};

/**
 * A local OpenAI-compatible server with scripted replies and fault injection: rate limits
 * with Retry-After, 5xx, malformed chunks, connections dropped mid-stream, and hangs.
 */
export async function startFakeOpenAI(): Promise<FakeOpenAI> {
    const queue: FakeReply[] = [];
    const requests: FakeOpenAI["requests"] = [];
    const server: Server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", async () => {
            requests.push({ headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
            const reply = queue.shift() ?? { kind: "error", status: 500, body: { error: { message: "no scripted reply" } } };
            if (reply.kind === "hang") return;
            if (reply.kind === "error") {
                res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers }).end(JSON.stringify(reply.body ?? {}));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (reply.kind === "raw") {
                res.end(reply.body);
                return;
            }
            for (const [i, c] of reply.chunks.entries()) {
                if (reply.dropAfter !== undefined && i >= reply.dropAfter) {
                    // Let what was written reach the client, then cut the connection.
                    await new Promise((resolve) => setTimeout(resolve, 30));
                    res.socket?.destroy();
                    return;
                }
                res.write(`data: ${JSON.stringify(c)}\n\n`);
                if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
            }
            if (reply.done !== false) res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
        url: `http://localhost:${port}/v1`,
        requests,
        enqueue: (...replies) => queue.push(...replies),
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
