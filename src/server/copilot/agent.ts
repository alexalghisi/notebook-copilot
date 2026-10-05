import type { Proposal } from "../../shared/proposal.ts";
import { ModelError, type ChatMessage, type ChatModel, type ToolCall, type ToolSpec, type Usage } from "./model.ts";
import { costUsd, type Price } from "./pricing.ts";
import { countTokens, truncateToTokens } from "./tokens.ts";
import type { ToolOutcome } from "./tools.ts";

export interface AgentLimits {
    maxSteps: number;
    maxCostUsd: number;
    /** Prompt plus completion tokens across all steps. */
    maxTotalTokens: number;
    maxOutputTokens: number;
    maxToolResultTokens: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
    maxSteps: 6,
    maxCostUsd: 0.05,
    maxTotalTokens: 60_000,
    maxOutputTokens: 800,
    maxToolResultTokens: 600,
};

export type StopReason = "answer" | "proposal" | "step_limit" | "cost_limit" | "token_limit" | "error" | "cancelled";

export interface AgentUsage extends Usage {
    costUsd: number;
    /** True when the server didn't report usage and it was counted locally. */
    estimated: boolean;
}

export type AgentEvent =
    | { type: "step"; step: number }
    | { type: "text"; delta: string }
    | { type: "tool_call"; step: number; call: ToolCall }
    | { type: "tool_result"; step: number; callId: string; name: string; summary: string; isError: boolean }
    | { type: "proposal"; proposal: Proposal }
    | { type: "usage"; usage: AgentUsage };

export interface AgentResult {
    stopReason: StopReason;
    answer: string;
    steps: number;
    usage: AgentUsage;
    proposal: Proposal | null;
    error: string | null;
}

export interface AgentOptions {
    model: ChatModel;
    price: Price;
    messages: ChatMessage[];
    tools: ToolSpec[];
    executeTool: (call: ToolCall) => Promise<ToolOutcome>;
    limits?: Partial<AgentLimits>;
    signal?: AbortSignal;
}

/**
 * The tool loop: ask the model, run the tools it calls, feed the results back, repeat.
 *
 * It stops when the model answers without calling a tool, when it proposes an edit (the
 * user takes over from there), or when a limit would be crossed. Cost and token limits are
 * checked before each call using the size of the prompt about to be sent, so the loop
 * stops before overspending rather than after.
 */
export async function* runAgent(options: AgentOptions): AsyncGenerator<AgentEvent, AgentResult> {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const messages = [...options.messages];
    const usage: AgentUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0, estimated: false };
    let answer = "";
    let step = 0;

    const finish = (stopReason: StopReason, proposal: Proposal | null = null, error: string | null = null): AgentResult => ({
        stopReason,
        answer: answer.trim(),
        steps: step,
        usage: { ...usage },
        proposal,
        error,
    });

    while (step < limits.maxSteps) {
        if (options.signal?.aborted) return finish("cancelled");
        const promptTokens = estimatePrompt(messages, options.tools);
        const projected: Usage = { promptTokens, completionTokens: limits.maxOutputTokens };
        if (usage.costUsd + costUsd(projected, options.price) > limits.maxCostUsd) return finish("cost_limit");
        if (usage.promptTokens + usage.completionTokens + promptTokens + limits.maxOutputTokens > limits.maxTotalTokens) {
            return finish("token_limit");
        }

        step += 1;
        yield { type: "step", step };
        let text = "";
        const calls: ToolCall[] = [];
        let reported: Usage | null = null;
        try {
            for await (const event of options.model.stream({
                messages,
                tools: options.tools,
                maxTokens: limits.maxOutputTokens,
                ...(options.signal ? { signal: options.signal } : {}),
            })) {
                if (event.type === "text") {
                    text += event.delta;
                    yield { type: "text", delta: event.delta };
                } else if (event.type === "tool_call") {
                    calls.push(event.call);
                } else if (event.type === "usage") {
                    reported = event.usage;
                }
            }
        } catch (error) {
            if (options.signal?.aborted) return finish("cancelled");
            const message = error instanceof ModelError ? error.message : `model failed: ${(error as Error).message}`;
            return finish("error", null, message);
        }

        const stepUsage = reported ?? {
            promptTokens,
            completionTokens: countTokens(text) + calls.reduce((n, c) => n + countTokens(c.name) + countTokens(c.arguments), 0),
        };
        usage.promptTokens += stepUsage.promptTokens;
        usage.completionTokens += stepUsage.completionTokens;
        usage.costUsd += costUsd(stepUsage, options.price);
        usage.estimated ||= reported === null;
        yield { type: "usage", usage: { ...usage } };

        answer += text;
        messages.push({ role: "assistant", content: text, ...(calls.length ? { toolCalls: calls } : {}) });
        if (calls.length === 0) return finish("answer");
        if (text && !text.endsWith("\n")) answer += "\n";

        let proposal: Proposal | null = null;
        for (const call of calls) {
            yield { type: "tool_call", step, call };
            let outcome: ToolOutcome;
            try {
                outcome = await options.executeTool(call);
            } catch (error) {
                outcome = { content: `tool failed: ${(error as Error).message}`, summary: `${call.name} failed`, isError: true };
            }
            messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: truncateResult(outcome.content, limits.maxToolResultTokens) });
            yield { type: "tool_result", step, callId: call.id, name: call.name, summary: outcome.summary, isError: outcome.isError };
            if (outcome.proposal) {
                proposal = outcome.proposal;
                yield { type: "proposal", proposal };
            }
        }
        if (proposal) return finish("proposal", proposal);
    }
    return finish("step_limit");
}

/** Counts what the next request will send. Per-message framing adds a few tokens each. */
export function estimatePrompt(messages: ChatMessage[], tools: ToolSpec[]): number {
    let total = countTokens(JSON.stringify(tools));
    for (const message of messages) {
        total += 4 + countTokens(message.content);
        if (message.role === "assistant" && message.toolCalls) {
            for (const call of message.toolCalls) total += countTokens(call.name) + countTokens(call.arguments) + 4;
        }
    }
    return total;
}

function truncateResult(content: string, maxTokens: number): string {
    if (countTokens(content) <= maxTokens) return content;
    return `${truncateToTokens(content, maxTokens - 12)}\n[truncated to fit the context]`;
}
