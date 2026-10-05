import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { cellSource, findCell } from "../shared/notebook.ts";
import { anchorProposal, applyAnchored, replaceText, type AnchoredEdit } from "../shared/proposal.ts";
import { runCell, streamCopilot, type ContextItem, type CopilotEvent, type ProposalData } from "./api.ts";

export interface CopilotRequest {
    action: "ask" | "edit";
    prompt: string;
    cellId: string | null;
}

export interface ToolStep {
    name: string;
    args: string;
    summary: string | null;
    isError: boolean;
}

export type ProposalState = "pending" | "stale" | "applied" | "rejected";

export interface Session {
    request: CopilotRequest;
    status: "running" | "done" | "error";
    model: string | null;
    text: string;
    tools: ToolStep[];
    context: { tokens: number; budget: number; items: ContextItem[] } | null;
    proposal: ProposalData | null;
    proposalState: ProposalState;
    usage: CopilotEvent["usage"];
    stopReason: string | null;
    latencyMs: number | null;
    firstTokenMs: number | null;
    error: string | null;
}

export interface Copilot {
    session: Session | null;
    start(request: CopilotRequest): void;
    /** Applies the proposal through the CRDT; `force` replaces the whole cell when it changed meanwhile. */
    accept(force: boolean): void;
    reject(): void;
}

/**
 * Runs copilot requests for one notebook and turns the event stream into view state. A new
 * request aborts the previous one, which also stops its model call on the server.
 */
export function useCopilot(notebookId: string, doc: Y.Doc): Copilot {
    const [session, setSession] = useState<Session | null>(null);
    const controller = useRef<AbortController | null>(null);
    const anchored = useRef<AnchoredEdit[] | null>(null);

    useEffect(() => () => controller.current?.abort(), []);

    const start = useCallback(
        (request: CopilotRequest) => {
            controller.current?.abort();
            const abort = new AbortController();
            controller.current = abort;
            anchored.current = null;
            setSession(initial(request));
            const update = (fn: (s: Session) => Session) => setSession((s) => (s && s.request === request ? fn(s) : s));
            void (async () => {
                try {
                    for await (const event of streamCopilot({ notebookId, ...request }, abort.signal)) {
                        if (event.kind === "proposal" && event.proposal) {
                            // Anchor now, while the cell still matches what the copilot saw.
                            const cell = findCell(doc, event.proposal.cellId);
                            anchored.current = cell ? anchorProposal(cellSource(cell), event.proposal.base, event.proposal.proposed) : null;
                        }
                        const anchoredOk = anchored.current !== null;
                        update((s) => reduce(s, event, anchoredOk));
                    }
                } catch (error) {
                    if (!abort.signal.aborted) update((s) => ({ ...s, status: "error", error: (error as Error).message }));
                }
            })();
        },
        [notebookId, doc],
    );

    const accept = useCallback(
        (force: boolean) => {
            if (!session?.proposal) return;
            const cell = findCell(doc, session.proposal.cellId);
            if (!cell) return;
            if (anchored.current && !force) applyAnchored(cellSource(cell), anchored.current);
            else replaceText(cellSource(cell), session.proposal.proposed);
            setSession({ ...session, proposalState: "applied" });
            void runCell(notebookId, session.proposal.cellId).catch(() => undefined);
        },
        [session, doc, notebookId],
    );

    const reject = useCallback(() => setSession((s) => (s ? { ...s, proposalState: "rejected" } : s)), []);

    return { session, start, accept, reject };
}

function initial(request: CopilotRequest): Session {
    return {
        request,
        status: "running",
        model: null,
        text: "",
        tools: [],
        context: null,
        proposal: null,
        proposalState: "pending",
        usage: null,
        stopReason: null,
        latencyMs: null,
        firstTokenMs: null,
        error: null,
    };
}

function reduce(s: Session, event: CopilotEvent, anchoredOk: boolean): Session {
    switch (event.kind) {
        case "started":
            return { ...s, model: event.model };
        case "context":
            return { ...s, context: { tokens: event.contextTokens ?? 0, budget: event.contextBudget ?? 0, items: event.contextItems ?? [] } };
        case "text":
            return { ...s, text: s.text + (event.text ?? "") };
        case "tool_call":
            return {
                ...s,
                text: s.text && !s.text.endsWith("\n") ? `${s.text}\n` : s.text,
                tools: [...s.tools, { name: event.toolName ?? "?", args: event.toolArguments ?? "", summary: null, isError: false }],
            };
        case "tool_result": {
            const tools = [...s.tools];
            const index = tools.findLastIndex((t) => t.name === event.toolName && t.summary === null);
            if (index >= 0) tools[index] = { ...tools[index]!, summary: event.toolSummary, isError: Boolean(event.isError) };
            return { ...s, tools };
        }
        case "proposal":
            return { ...s, proposal: event.proposal, proposalState: anchoredOk ? "pending" : "stale" };
        case "usage":
            return { ...s, usage: event.usage };
        case "done":
            return {
                ...s,
                status: event.stopReason === "error" ? "error" : "done",
                usage: event.usage ?? s.usage,
                stopReason: event.stopReason,
                latencyMs: event.latencyMs,
                firstTokenMs: event.firstTokenMs,
                error: event.error,
            };
        default:
            return s;
    }
}
