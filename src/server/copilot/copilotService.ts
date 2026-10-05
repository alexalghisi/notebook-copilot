import type pg from "pg";
import { readNotebook } from "../../shared/notebook.ts";
import type { Proposal } from "../../shared/proposal.ts";
import type { RoomManager } from "../collab/roomManager.ts";
import type { AgentResult } from "./agent.ts";
import type { ContextItemReport } from "./context.ts";
import type { CopilotAction } from "./prompts.ts";
import { runSession, type SessionDeps, type SessionEvent } from "./session.ts";

export interface CopilotInput {
    notebookId: string;
    action: CopilotAction;
    prompt: string;
    cellId: string | null;
}

export type CopilotEvent =
    | { kind: "started"; requestId: string; model: string }
    | SessionEvent
    | { kind: "done"; requestId: string; result: AgentResult; latencyMs: number; firstTokenMs: number | null };

export class CopilotInputError extends Error {}

export interface CopilotDeps extends SessionDeps {
    pool: pg.Pool;
    rooms: RoomManager;
}

export interface CopilotRequestRow {
    id: string;
    action: CopilotAction;
    cellId: string | null;
    prompt: string;
    model: string;
    status: string;
    stopReason: string | null;
    answer: string | null;
    proposal: Proposal | null;
    contextTokens: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    costUsd: number | null;
    steps: number | null;
    latencyMs: number | null;
    createdAt: Date;
}

/**
 * One copilot request end to end: snapshot the live notebook, pack the context, run the
 * agent, stream every event to the caller and record the outcome (tokens, cost, latency,
 * stop reason) so quality and spend can be looked at per request later.
 */
export class CopilotService {
    constructor(private readonly deps: CopilotDeps) {}

    get modelName(): string {
        return this.deps.model.name;
    }

    async *run(input: CopilotInput, signal?: AbortSignal): AsyncGenerator<CopilotEvent> {
        const started = performance.now();
        const prompt = input.prompt.trim().slice(0, 4_000);
        if (input.action === "ask" && !prompt) throw new CopilotInputError("a question is required");
        if (input.action === "edit" && !input.cellId) throw new CopilotInputError("editing needs a cellId");

        const notebook = await this.deps.rooms.withRoom(input.notebookId, (room) => readNotebook(room.doc));
        if (input.cellId && !notebook.cells.some((c) => c.id === input.cellId)) throw new CopilotInputError(`cell ${input.cellId} not found`);

        const { rows } = await this.deps.pool.query<{ id: string }>(
            `INSERT INTO copilot_requests (notebook_id, action, cell_id, prompt, model, status) VALUES ($1, $2, $3, $4, $5, 'running') RETURNING id`,
            [input.notebookId, input.action, input.cellId, prompt, this.deps.model.name],
        );
        const requestId = rows[0]!.id;
        yield { kind: "started", requestId, model: this.deps.model.name };

        let firstTokenMs: number | null = null;
        let result: AgentResult | null = null;
        let contextTokens = 0;
        let contextItems: ContextItemReport[] = [];
        try {
            const session = runSession(this.deps, { notebookId: input.notebookId, notebook, action: input.action, prompt, cellId: input.cellId }, signal);
            for (;;) {
                const next = await session.next();
                if (next.done) {
                    result = next.value;
                    break;
                }
                const event = next.value;
                if ("kind" in event) {
                    contextTokens = event.tokens;
                    contextItems = event.items;
                } else if (event.type === "text" && firstTokenMs === null) {
                    firstTokenMs = Math.round(performance.now() - started);
                }
                yield event;
            }
        } finally {
            const latencyMs = Math.round(performance.now() - started);
            await this.record(requestId, result, contextTokens, contextItems, latencyMs, firstTokenMs);
            if (result) yield { kind: "done", requestId, result, latencyMs, firstTokenMs };
        }
    }

    async list(notebookId: string, limit = 20): Promise<CopilotRequestRow[]> {
        const { rows } = await this.deps.pool.query<{
            id: string;
            action: CopilotAction;
            cell_id: string | null;
            prompt: string;
            model: string;
            status: string;
            stop_reason: string | null;
            answer: string | null;
            proposal: Proposal | null;
            context_tokens: number | null;
            prompt_tokens: number | null;
            completion_tokens: number | null;
            cost_usd: string | null;
            steps: number | null;
            latency_ms: number | null;
            created_at: Date;
        }>(`SELECT * FROM copilot_requests WHERE notebook_id = $1 ORDER BY created_at DESC LIMIT $2`, [notebookId, Math.min(limit, 100)]);
        return rows.map((r) => ({
            id: r.id,
            action: r.action,
            cellId: r.cell_id,
            prompt: r.prompt,
            model: r.model,
            status: r.status,
            stopReason: r.stop_reason,
            answer: r.answer,
            proposal: r.proposal,
            contextTokens: r.context_tokens,
            promptTokens: r.prompt_tokens,
            completionTokens: r.completion_tokens,
            costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
            steps: r.steps,
            latencyMs: r.latency_ms,
            createdAt: r.created_at,
        }));
    }

    private async record(
        requestId: string,
        result: AgentResult | null,
        contextTokens: number,
        contextItems: ContextItemReport[],
        latencyMs: number,
        firstTokenMs: number | null,
    ): Promise<void> {
        // No result means the consumer went away or something threw mid-run.
        const failed = !result || result.stopReason === "error";
        await this.deps.pool
            .query(
                `UPDATE copilot_requests SET status = $2, stop_reason = $3, answer = $4, proposal = $5, context_tokens = $6, context_items = $7,
                     prompt_tokens = $8, completion_tokens = $9, usage_estimated = $10, cost_usd = $11, steps = $12, latency_ms = $13,
                     first_token_ms = $14, error = $15
                 WHERE id = $1`,
                [
                    requestId,
                    failed ? "failed" : "done",
                    result?.stopReason ?? "cancelled",
                    result?.answer ?? null,
                    result?.proposal ? JSON.stringify(result.proposal) : null,
                    contextTokens,
                    JSON.stringify(contextItems),
                    result?.usage.promptTokens ?? null,
                    result?.usage.completionTokens ?? null,
                    result?.usage.estimated ?? null,
                    result?.usage.costUsd ?? null,
                    result?.steps ?? null,
                    latencyMs,
                    firstTokenMs,
                    result?.error ?? (result ? null : "request ended before the agent finished"),
                ],
            )
            .catch((error: unknown) => console.error("recording copilot request failed:", error));
    }
}
