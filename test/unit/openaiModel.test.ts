import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ModelError, type ModelEvent } from "../../src/server/copilot/model.ts";
import { OpenAIModel } from "../../src/server/copilot/openaiModel.ts";
import { chunk, startFakeOpenAI, type FakeOpenAI } from "../helpers/fakeOpenAI.ts";

let fake: FakeOpenAI;
const sleeps: number[] = [];

beforeAll(async () => {
    fake = await startFakeOpenAI();
});
afterAll(() => fake.close());
afterEach(() => {
    fake.requests.length = 0;
    sleeps.length = 0;
});

function model(overrides: Partial<ConstructorParameters<typeof OpenAIModel>[0]> = {}) {
    return new OpenAIModel({
        baseUrl: fake.url,
        apiKey: "test-key",
        model: "gpt-4o-mini",
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        ...overrides,
    });
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
    const out: ModelEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
}

const request = {
    messages: [
        { role: "system" as const, content: "be brief" },
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "run_query", arguments: '{"sql":"select 1"}' }] },
        { role: "tool" as const, toolCallId: "c1", name: "run_query", content: "1 row" },
    ],
    tools: [{ name: "run_query", description: "runs SQL", parameters: { type: "object", properties: { sql: { type: "string" } } } }],
    maxTokens: 300,
};

describe("OpenAIModel", () => {
    it("streams text deltas, then finish and usage, and sends a well-formed request", async () => {
        fake.enqueue({ kind: "stream", chunks: [chunk.text("Hel"), chunk.text("lo"), chunk.finish("stop"), chunk.usage(42, 2)], delayMs: 5 });
        const events = await collect(model().stream(request));
        expect(events).toEqual([
            { type: "text", delta: "Hel" },
            { type: "text", delta: "lo" },
            { type: "finish", reason: "stop" },
            { type: "usage", usage: { promptTokens: 42, completionTokens: 2 } },
        ]);
        const sent = fake.requests[0]!;
        expect(sent.headers.authorization).toBe("Bearer test-key");
        expect(sent.body).toMatchObject({ model: "gpt-4o-mini", stream: true, stream_options: { include_usage: true }, max_tokens: 300 });
        expect(sent.body.messages).toEqual([
            { role: "system", content: "be brief" },
            { role: "user", content: "hi" },
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "run_query", arguments: '{"sql":"select 1"}' } }] },
            { role: "tool", tool_call_id: "c1", content: "1 row" },
        ]);
        expect(sent.body.tools).toEqual([{ type: "function", function: request.tools[0] }]);
    });

    it("assembles parallel tool calls from fragments and emits each once, in index order", async () => {
        fake.enqueue({
            kind: "stream",
            chunks: [
                chunk.toolStart(0, "call_a", "inspect_schema"),
                chunk.toolStart(1, "call_b", "run_query"),
                chunk.toolArgs(1, '{"sql": "sel'),
                chunk.toolArgs(0, '{"table":'),
                chunk.toolArgs(1, 'ect 1"}'),
                chunk.toolArgs(0, '"orders"}'),
                chunk.finish("tool_calls"),
            ],
        });
        const events = await collect(model().stream(request));
        expect(events.filter((e) => e.type === "tool_call")).toEqual([
            { type: "tool_call", call: { id: "call_a", name: "inspect_schema", arguments: '{"table":"orders"}' } },
            { type: "tool_call", call: { id: "call_b", name: "run_query", arguments: '{"sql": "select 1"}' } },
        ]);
    });

    it("retries rate limits honouring Retry-After, and server errors with backoff", async () => {
        fake.enqueue(
            { kind: "error", status: 429, headers: { "retry-after": "2" }, body: { error: { message: "slow down" } } },
            { kind: "error", status: 503 },
            { kind: "stream", chunks: [chunk.text("ok"), chunk.finish("stop")] },
        );
        const events = await collect(model().stream(request));
        expect(events[0]).toEqual({ type: "text", delta: "ok" });
        expect(fake.requests).toHaveLength(3);
        expect(sleeps).toEqual([2000, 1000]);
    });

    it("gives up after the retry budget with the server's message", async () => {
        fake.enqueue({ kind: "error", status: 500, body: { error: { message: "boom" } } }, { kind: "error", status: 500, body: { error: { message: "boom" } } });
        const error = await collect(model({ maxRetries: 1 }).stream(request)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ModelError);
        expect(error).toMatchObject({ status: 500, retryable: true, message: "model returned 500: boom" });
    });

    it("does not retry client errors", async () => {
        fake.enqueue({ kind: "error", status: 401, body: { error: { message: "invalid api key" } } });
        await expect(collect(model().stream(request))).rejects.toMatchObject({ status: 401, retryable: false });
        expect(fake.requests).toHaveLength(1);
    });

    it("fails on malformed chunks and on streams cut off before finishing", async () => {
        fake.enqueue({ kind: "raw", body: 'data: {"choices": [\n\n' });
        await expect(collect(model().stream(request))).rejects.toThrow(/malformed stream chunk/);

        fake.enqueue({ kind: "stream", chunks: [chunk.text("par"), chunk.text("tial"), chunk.finish("stop")], dropAfter: 2 });
        const seen: ModelEvent[] = [];
        const error = await (async () => {
            for await (const e of model().stream(request)) seen.push(e);
        })().catch((e: unknown) => e);
        expect(seen).toEqual([{ type: "text", delta: "par" }, { type: "text", delta: "tial" }]);
        expect(error).toBeInstanceOf(ModelError);
        // Nothing is retried once text has been streamed.
        expect(fake.requests).toHaveLength(2);
    });

    it("stops when the caller aborts and when the request times out", async () => {
        fake.enqueue({ kind: "hang" });
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error("user cancelled")), 50);
        await expect(collect(model().stream({ ...request, signal: controller.signal }))).rejects.toThrow();

        fake.enqueue({ kind: "hang" });
        await expect(collect(model({ timeoutMs: 50, maxRetries: 0 }).stream(request))).rejects.toThrow(ModelError);
    });
});
