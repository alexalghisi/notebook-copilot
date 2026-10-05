import { describe, expect, it } from "vitest";
import { runAgent, type AgentEvent, type AgentResult } from "../../src/server/copilot/agent.ts";
import { ModelError, type ChatModel, type ModelEvent, type ModelRequest, type ToolCall } from "../../src/server/copilot/model.ts";
import { OpenAIModel } from "../../src/server/copilot/openaiModel.ts";
import type { ToolOutcome } from "../../src/server/copilot/tools.ts";
import { chunk, startFakeOpenAI } from "../helpers/fakeOpenAI.ts";

/** A model that replays scripted turns and records what it was sent. */
class ScriptedModel implements ChatModel {
    readonly name = "scripted";
    readonly requests: ModelRequest[] = [];
    constructor(private readonly turns: Array<ModelEvent[] | Error>) {}
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        this.requests.push({ ...request, messages: [...request.messages] });
        const turn = this.turns.shift() ?? [{ type: "text", delta: "done" }];
        if (turn instanceof Error) throw turn;
        yield* turn;
    }
}

const toolCall = (id: string, name: string, args: object): ModelEvent => ({ type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } });
const FREE = { input: 0, output: 0 };

async function drive(options: Parameters<typeof runAgent>[0]): Promise<{ events: AgentEvent[]; result: AgentResult }> {
    const events: AgentEvent[] = [];
    const agent = runAgent(options);
    for (;;) {
        const next = await agent.next();
        if (next.done) return { events, result: next.value };
        events.push(next.value);
    }
}

const base = {
    price: FREE,
    messages: [
        { role: "system" as const, content: "sys" },
        { role: "user" as const, content: "fix it" },
    ],
    tools: [],
};

describe("runAgent", () => {
    it("runs tools, feeds results back and stops at the final answer", async () => {
        const model = new ScriptedModel([
            [{ type: "text", delta: "Checking. " }, toolCall("a", "run_query", { sql: "select 1" })],
            [{ type: "text", delta: "It returns one row." }],
        ]);
        const executed: ToolCall[] = [];
        const { events, result } = await drive({
            ...base,
            model,
            executeTool: async (call) => {
                executed.push(call);
                return { content: "1 row\n?column?\n1", summary: "query returned 1 rows", isError: false };
            },
        });
        expect(result).toMatchObject({ stopReason: "answer", steps: 2, answer: "Checking. \nIt returns one row." });
        expect(executed.map((c) => c.name)).toEqual(["run_query"]);
        expect(model.requests[1]!.messages.slice(-2)).toEqual([
            { role: "assistant", content: "Checking. ", toolCalls: [{ id: "a", name: "run_query", arguments: '{"sql":"select 1"}' }] },
            { role: "tool", toolCallId: "a", name: "run_query", content: "1 row\n?column?\n1" },
        ]);
        expect(events.map((e) => e.type)).toEqual(["step", "text", "usage", "tool_call", "tool_result", "step", "text", "usage"]);
    });

    it("stops after a proposal and reports it", async () => {
        const model = new ScriptedModel([[toolCall("p", "propose_edit", {})]]);
        const proposal = { cellId: "c1", base: "a", proposed: "b", explanation: "x" };
        const { events, result } = await drive({
            ...base,
            model,
            executeTool: async (): Promise<ToolOutcome> => ({ content: "ok", summary: "proposed", isError: false, proposal }),
        });
        expect(result.stopReason).toBe("proposal");
        expect(result.proposal).toEqual(proposal);
        expect(events.some((e) => e.type === "proposal")).toBe(true);
    });

    it("enforces the step limit", async () => {
        const loop = () => [toolCall(`c${Math.random()}`, "inspect_schema", {})];
        const model = new ScriptedModel([loop(), loop(), loop(), loop()]);
        const { result } = await drive({
            ...base,
            model,
            limits: { maxSteps: 3 },
            executeTool: async () => ({ content: "t(x int)", summary: "", isError: false }),
        });
        expect(result).toMatchObject({ stopReason: "step_limit", steps: 3 });
    });

    it("stops before a call whose projected cost would cross the limit", async () => {
        const model = new ScriptedModel([
            [toolCall("a", "inspect_schema", {}), { type: "usage", usage: { promptTokens: 1_000, completionTokens: 100 } }],
            [{ type: "text", delta: "never reached" }],
        ]);
        // $10 per million input tokens: step one costs ~$0.011; the second would push past $0.015.
        const { result } = await drive({
            ...base,
            model,
            price: { input: 10, output: 10 },
            limits: { maxCostUsd: 0.015, maxOutputTokens: 200 },
            executeTool: async () => ({ content: "x".repeat(2000), summary: "", isError: false }),
        });
        expect(result.stopReason).toBe("cost_limit");
        expect(result.steps).toBe(1);
        expect(result.usage.costUsd).toBeCloseTo(0.011, 6);
        expect(model.requests).toHaveLength(1);
    });

    it("stops on the total token budget and estimates usage the server didn't report", async () => {
        const model = new ScriptedModel([[{ type: "text", delta: "hello" }, toolCall("a", "inspect_schema", {})]]);
        const { result } = await drive({
            ...base,
            model,
            limits: { maxTotalTokens: 1_000, maxOutputTokens: 100, maxToolResultTokens: 2_000 },
            executeTool: async () => ({ content: "word ".repeat(1500), summary: "", isError: false }),
        });
        expect(result.stopReason).toBe("token_limit");
        expect(result.usage.estimated).toBe(true);
        expect(result.usage.completionTokens).toBeGreaterThan(0);
    });

    it("truncates large tool results before sending them back", async () => {
        const model = new ScriptedModel([[toolCall("a", "run_query", {})], [{ type: "text", delta: "ok" }]]);
        await drive({ ...base, model, limits: { maxToolResultTokens: 50 }, executeTool: async () => ({ content: "row ".repeat(500), summary: "", isError: false }) });
        const toolMessage = model.requests[1]!.messages.at(-1)!;
        expect(toolMessage.content).toMatch(/\[truncated to fit the context\]$/);
        expect(toolMessage.content.length).toBeLessThan(400);
    });

    it("turns tool exceptions into error results the model can react to", async () => {
        const model = new ScriptedModel([[toolCall("a", "run_query", {})], [{ type: "text", delta: "sorry" }]]);
        const { events, result } = await drive({ ...base, model, executeTool: async () => Promise.reject(new Error("db down")) });
        expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, summary: "run_query failed" });
        expect(model.requests[1]!.messages.at(-1)!.content).toBe("tool failed: db down");
        expect(result.stopReason).toBe("answer");
    });

    it("ends with an error result when the model fails", async () => {
        const model = new ScriptedModel([new ModelError("model returned 500: boom", 500, true)]);
        const { result } = await drive({ ...base, model, executeTool: async () => ({ content: "", summary: "", isError: false }) });
        expect(result).toMatchObject({ stopReason: "error", error: "model returned 500: boom" });
    });

    it("drives a real tool-calling exchange through the HTTP adapter and a fake server", async () => {
        const fake = await startFakeOpenAI();
        try {
            fake.enqueue(
                {
                    kind: "stream",
                    chunks: [chunk.text("Let me look."), chunk.toolStart(0, "call_1", "inspect_schema"), chunk.toolArgs(0, '{"table":"orders"}'), chunk.finish("tool_calls"), chunk.usage(120, 15)],
                },
                { kind: "stream", chunks: [chunk.text("orders has 4 columns."), chunk.finish("stop"), chunk.usage(180, 8)] },
            );
            const model = new OpenAIModel({ baseUrl: fake.url, apiKey: "k", model: "gpt-4o-mini" });
            const { result } = await drive({
                ...base,
                model,
                price: { input: 0.15, output: 0.6 },
                executeTool: async (call) => ({ content: `orders(id integer) for ${call.arguments}`, summary: "described orders", isError: false }),
            });
            expect(result).toMatchObject({ stopReason: "answer", steps: 2, usage: { promptTokens: 300, completionTokens: 23, estimated: false } });
            expect(result.usage.costUsd).toBeCloseTo((300 * 0.15 + 23 * 0.6) / 1e6, 10);
            const second = fake.requests[1]!.body.messages as Array<Record<string, unknown>>;
            expect(second.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: 'orders(id integer) for {"table":"orders"}' });
        } finally {
            await fake.close();
        }
    });
});
