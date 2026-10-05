import type { NotebookSnapshot } from "../../shared/notebook.ts";
import type { SchemaCatalog } from "../exec/schema.ts";
import type { QueryRunner } from "../exec/sqlRunner.ts";
import { runAgent, type AgentEvent, type AgentLimits, type AgentResult } from "./agent.ts";
import { buildContext, type ContextItemReport } from "./context.ts";
import type { ChatModel } from "./model.ts";
import type { Price } from "./pricing.ts";
import { SYSTEM_PROMPT, userMessage, type CopilotAction } from "./prompts.ts";
import { countTokens } from "./tokens.ts";
import { TOOL_SPECS, executeTool, type RunLookup } from "./tools.ts";

export interface SessionDeps {
    schema: SchemaCatalog;
    runner: QueryRunner;
    runs: RunLookup;
    model: ChatModel;
    price: Price;
    limits?: Partial<AgentLimits>;
    /** Tokens available to the notebook context, after the system prompt and the task. */
    contextBudget: number;
    previewRows?: number;
}

export interface SessionInput {
    notebookId: string;
    notebook: NotebookSnapshot;
    action: CopilotAction;
    prompt: string;
    cellId: string | null;
}

export type SessionEvent = { kind: "context"; tokens: number; budgetTokens: number; items: ContextItemReport[] } | AgentEvent;

/**
 * Context packing plus the agent loop over a notebook snapshot. Storage-free, so the live
 * service and the eval harness run exactly the same code path.
 */
export async function* runSession(deps: SessionDeps, input: SessionInput, signal?: AbortSignal): AsyncGenerator<SessionEvent, AgentResult> {
    const tables = await deps.schema.tables();
    const taskTokens = countTokens(userMessage(input.action, input.prompt, input.cellId, ""));
    const packed = buildContext({
        notebook: input.notebook,
        focusCellId: input.cellId,
        prompt: input.prompt,
        tables,
        budgetTokens: Math.max(0, deps.contextBudget - taskTokens),
    });
    yield { kind: "context", tokens: packed.tokens, budgetTokens: packed.budgetTokens, items: packed.items };

    return yield* runAgent({
        model: deps.model,
        price: deps.price,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage(input.action, input.prompt, input.cellId, packed.text) },
        ],
        tools: TOOL_SPECS,
        executeTool: (call) =>
            executeTool(call, {
                notebookId: input.notebookId,
                notebook: input.notebook,
                schema: deps.schema,
                runner: deps.runner,
                runs: deps.runs,
                previewRows: deps.previewRows ?? 20,
            }),
        ...(deps.limits ? { limits: deps.limits } : {}),
        ...(signal ? { signal } : {}),
    });
}
