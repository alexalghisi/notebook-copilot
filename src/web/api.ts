import { subscribe } from "../shared/graphqlStream.ts";

const ENDPOINT = "/graphql";

export class ApiError extends Error {}

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new ApiError(body.errors.map((e) => e.message).join("; "));
    if (!body.data) throw new ApiError(`empty response (HTTP ${response.status})`);
    return body.data;
}

export interface NotebookSummary {
    id: string;
    title: string;
    createdAt: string;
}

export interface Column {
    name: string;
    type: string;
}

export interface RunData {
    id: string;
    status: "running" | "succeeded" | "failed";
    columns: Column[];
    rows: unknown[][];
    rowCount: number | null;
    truncated: boolean;
    error: string | null;
    errorPosition: number | null;
    durationMs: number | null;
}

export interface ContextItem {
    kind: string;
    id: string;
    tokens: number;
    status: string;
    reason: string;
}

export interface ProposalData {
    cellId: string;
    base: string;
    proposed: string;
    explanation: string;
    diff: Array<{ kind: "same" | "add" | "del"; text: string }>;
}

export interface CopilotEvent {
    kind: "started" | "context" | "step" | "text" | "tool_call" | "tool_result" | "proposal" | "usage" | "done";
    requestId: string;
    model: string | null;
    step: number | null;
    text: string | null;
    toolName: string | null;
    toolArguments: string | null;
    toolSummary: string | null;
    isError: boolean | null;
    contextTokens: number | null;
    contextBudget: number | null;
    contextItems: ContextItem[] | null;
    proposal: ProposalData | null;
    usage: { promptTokens: number; completionTokens: number; costUsd: number; estimated: boolean } | null;
    stopReason: string | null;
    error: string | null;
    latencyMs: number | null;
    firstTokenMs: number | null;
}

export const listNotebooks = () => gql<{ notebooks: NotebookSummary[] }>(`{ notebooks { id title createdAt } }`).then((d) => d.notebooks);

export const createNotebook = (title: string, fromTemplate: boolean) =>
    gql<{ createNotebook: NotebookSummary }>(`mutation($title: String!, $t: Boolean) { createNotebook(title: $title, fromTemplate: $t) { id title createdAt } }`, {
        title,
        t: fromTemplate,
    }).then((d) => d.createNotebook);

export const runCell = (notebookId: string, cellId: string) =>
    gql<{ runCell: { id: string } }>(`mutation($nb: ID!, $cell: ID!) { runCell(notebookId: $nb, cellId: $cell) { id } }`, { nb: notebookId, cell: cellId });

export const fetchRun = (id: string) =>
    gql<{ run: RunData | null }>(`query($id: ID!) { run(id: $id) { id status columns { name type } rows rowCount truncated error errorPosition durationMs } }`, {
        id,
    }).then((d) => d.run);

export const fetchModel = () => gql<{ copilotModel: string }>(`{ copilotModel }`).then((d) => d.copilotModel);

const COPILOT = `subscription($input: CopilotInput!) {
    copilot(input: $input) {
        kind requestId model step text toolName toolArguments toolSummary isError contextTokens contextBudget
        contextItems { kind id tokens status reason }
        proposal { cellId base proposed explanation diff { kind text } }
        usage { promptTokens completionTokens costUsd estimated }
        stopReason error latencyMs firstTokenMs
    }
}`;

export async function* streamCopilot(
    input: { notebookId: string; action: "ask" | "edit"; prompt: string; cellId: string | null },
    signal: AbortSignal,
): AsyncGenerator<CopilotEvent> {
    for await (const data of subscribe<{ copilot: CopilotEvent }>(ENDPOINT, COPILOT, { input }, signal)) yield data.copilot;
}
