/**
 * The model port. Both the OpenAI-compatible HTTP adapter and the offline model implement
 * it, so the agent loop, the service and the evals never know which one they talk to.
 */
export interface ToolCall {
    id: string;
    name: string;
    /** Raw JSON text as the model produced it; parsed (and validated) by the tool layer. */
    arguments: string;
}

export type ChatMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
    | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec {
    name: string;
    description: string;
    /** JSON Schema of the arguments object. */
    parameters: Record<string, unknown>;
}

export interface Usage {
    promptTokens: number;
    completionTokens: number;
}

export type ModelEvent =
    | { type: "text"; delta: string }
    | { type: "tool_call"; call: ToolCall }
    | { type: "usage"; usage: Usage }
    | { type: "finish"; reason: string };

export interface ModelRequest {
    messages: ChatMessage[];
    tools: ToolSpec[];
    maxTokens: number;
    temperature?: number;
    signal?: AbortSignal;
}

export interface ChatModel {
    readonly name: string;
    stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export class ModelError extends Error {
    constructor(
        message: string,
        readonly status: number | null = null,
        readonly retryable = false,
    ) {
        super(message);
        this.name = "ModelError";
    }
}
