import { ModelError, type ChatMessage, type ChatModel, type ModelEvent, type ModelRequest, type ToolCall } from "./model.ts";

export interface OpenAIModelOptions {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxRetries?: number;
    timeoutMs?: number;
    /** Injected for tests; defaults to global fetch. */
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

interface StreamChunk {
    choices?: Array<{
        delta?: {
            content?: string | null;
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * Chat completions over HTTP with streaming, for any OpenAI-compatible server.
 *
 * Retries happen only before the first byte of a response body: once tokens have been
 * streamed to the user, a retry would duplicate them, so a broken stream is an error.
 * Tool call arguments arrive in fragments keyed by index and are emitted whole, after
 * the stream says the call is complete.
 */
export class OpenAIModel implements ChatModel {
    readonly name: string;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly options: OpenAIModelOptions) {
        this.name = options.model;
        this.fetchImpl = options.fetch ?? fetch;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        const response = await this.connect(request);
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        let finished = false;

        for await (const data of sseData(response, request.signal)) {
            if (data === "[DONE]") break;
            let chunk: StreamChunk;
            try {
                chunk = JSON.parse(data) as StreamChunk;
            } catch {
                throw new ModelError(`malformed stream chunk: ${data.slice(0, 120)}`);
            }
            for (const choice of chunk.choices ?? []) {
                const content = choice.delta?.content;
                if (content) yield { type: "text", delta: content };
                for (const part of choice.delta?.tool_calls ?? []) {
                    const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
                    if (part.id) call.id = part.id;
                    if (part.function?.name) call.name += part.function.name;
                    if (part.function?.arguments) call.arguments += part.function.arguments;
                    calls.set(part.index, call);
                }
                if (choice.finish_reason) {
                    for (const [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
                        yield { type: "tool_call", call: { id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || "{}" } satisfies ToolCall };
                    }
                    calls.clear();
                    yield { type: "finish", reason: choice.finish_reason };
                    finished = true;
                }
            }
            if (chunk.usage) {
                yield { type: "usage", usage: { promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0 } };
            }
        }
        if (!finished) throw new ModelError("stream ended before the model finished");
    }

    private async connect(request: ModelRequest): Promise<Response> {
        const body = JSON.stringify({
            model: this.options.model,
            messages: request.messages.map(toWire),
            tools: request.tools.length
                ? request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
                : undefined,
            max_tokens: request.maxTokens,
            temperature: request.temperature ?? 0,
            stream: true,
            stream_options: { include_usage: true },
        });
        const maxRetries = this.options.maxRetries ?? 2;
        for (let attempt = 0; ; attempt++) {
            const signals = [AbortSignal.timeout(this.options.timeoutMs ?? 60_000), ...(request.signal ? [request.signal] : [])];
            let response: Response;
            try {
                response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
                    method: "POST",
                    headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}`, accept: "text/event-stream" },
                    body,
                    signal: AbortSignal.any(signals),
                });
            } catch (error) {
                if (request.signal?.aborted) throw error;
                if (attempt >= maxRetries) throw new ModelError(`request failed: ${(error as Error).message}`, null, true);
                await this.sleep(backoff(attempt));
                continue;
            }
            if (response.ok && response.body) return response;

            const text = await response.text().catch(() => "");
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable || attempt >= maxRetries) {
                throw new ModelError(`model returned ${response.status}: ${errorMessage(text)}`, response.status, retryable);
            }
            await this.sleep(retryAfterMs(response.headers.get("retry-after")) ?? backoff(attempt));
        }
    }
}

function toWire(message: ChatMessage): Record<string, unknown> {
    switch (message.role) {
        case "assistant":
            return {
                role: "assistant",
                content: message.content || null,
                ...(message.toolCalls?.length
                    ? { tool_calls: message.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
                    : {}),
            };
        case "tool":
            return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
        default:
            return { role: message.role, content: message.content };
    }
}

async function* sseData(response: Response, signal: AbortSignal | undefined): AsyncIterable<string> {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
        for (;;) {
            if (signal?.aborted) throw signal.reason;
            let result: ReadableStreamReadResult<string>;
            try {
                result = await reader.read();
            } catch (error) {
                if (signal?.aborted) throw error;
                throw new ModelError(`stream interrupted: ${(error as Error).message}`);
            }
            if (result.done) break;
            buffer += result.value;
            let boundary: number;
            while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
                const event = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
                const data = event
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                if (data) yield data;
            }
        }
    } finally {
        // Stops the download if the consumer stopped early (abort, error, step limit).
        await reader.cancel().catch(() => undefined);
    }
}

function backoff(attempt: number): number {
    return Math.min(8_000, 500 * 2 ** attempt);
}

function retryAfterMs(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.min(30_000, Math.max(0, date - Date.now())) : null;
}

function errorMessage(body: string): string {
    try {
        const parsed = JSON.parse(body) as { error?: { message?: string } };
        if (parsed.error?.message) return parsed.error.message;
    } catch {
        // not JSON
    }
    return body.slice(0, 200) || "no body";
}
