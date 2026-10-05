import { GraphQLScalarType, valueFromASTUntyped, type GraphQLError } from "graphql";
import { createGraphQLError } from "graphql-yoga";
import { readNotebook, type CellSnapshot } from "../../shared/notebook.ts";
import { lineDiff, type Proposal } from "../../shared/proposal.ts";
import type { RoomManager } from "../collab/roomManager.ts";
import { RunError, type Run, type RunService } from "../exec/runService.ts";
import type { SchemaCatalog } from "../exec/schema.ts";
import { CopilotInputError, type CopilotEvent, type CopilotInput, type CopilotRequestRow, type CopilotService } from "../copilot/copilotService.ts";
import { isUuid, type NotebookRepo, type NotebookRow } from "../notebooks.ts";
import { SHOP_ANALYSIS } from "../templates.ts";

export interface GraphQLContext {
    notebooks: NotebookRepo;
    runs: RunService;
    rooms: RoomManager;
    schema: SchemaCatalog;
    copilot: CopilotService;
}

const JSONScalar = new GraphQLScalarType({
    name: "JSON",
    serialize: (value) => value,
    parseValue: (value) => value,
    parseLiteral: (ast) => valueFromASTUntyped(ast),
});

function badInput(message: string): GraphQLError {
    // createGraphQLError builds the error with the same graphql module instance yoga checks against.
    return createGraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

function requireUuid(id: string, what: string): string {
    if (!isUuid(id)) throw badInput(`${what} must be a UUID`);
    return id;
}

function serializeRun(run: Run) {
    return { ...run, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null };
}

function serializeProposal(proposal: Proposal | null) {
    return proposal ? { ...proposal, diff: lineDiff(proposal.base, proposal.proposed) } : null;
}

/** Flattens service events into the GraphQL event type, tagging each with its request id. */
async function* copilotEvents(service: CopilotService, input: CopilotInput) {
    const controller = new AbortController();
    let requestId = "";
    try {
        for await (const event of service.run(input, controller.signal)) {
            if ("kind" in event && event.kind === "started") requestId = event.requestId;
            yield { copilot: { requestId, ...toGraphQLEvent(event) } };
        }
    } catch (error) {
        if (error instanceof CopilotInputError) throw badInput(error.message);
        throw error;
    } finally {
        // The client went away (or we finished): stop any model call still in flight.
        controller.abort();
    }
}

function toGraphQLEvent(event: CopilotEvent): Record<string, unknown> {
    if ("kind" in event) {
        switch (event.kind) {
            case "started":
                return { kind: "started", model: event.model };
            case "context":
                return { kind: "context", contextTokens: event.tokens, contextBudget: event.budgetTokens, contextItems: event.items };
            case "done":
                return {
                    kind: "done",
                    stopReason: event.result.stopReason,
                    answer: event.result.answer,
                    error: event.result.error,
                    usage: event.result.usage,
                    step: event.result.steps,
                    proposal: serializeProposal(event.result.proposal),
                    latencyMs: event.latencyMs,
                    firstTokenMs: event.firstTokenMs,
                };
        }
    }
    switch (event.type) {
        case "step":
            return { kind: "step", step: event.step };
        case "text":
            return { kind: "text", text: event.delta };
        case "tool_call":
            return { kind: "tool_call", step: event.step, toolName: event.call.name, toolArguments: event.call.arguments };
        case "tool_result":
            return { kind: "tool_result", step: event.step, toolName: event.name, toolSummary: event.summary, isError: event.isError };
        case "proposal":
            return { kind: "proposal", proposal: serializeProposal(event.proposal) };
        case "usage":
            return { kind: "usage", usage: event.usage };
    }
}

export const resolvers = {
    JSON: JSONScalar,
    Query: {
        notebooks: (_: unknown, __: unknown, ctx: GraphQLContext) => ctx.notebooks.list(),
        notebook: (_: unknown, args: { id: string }, ctx: GraphQLContext) => ctx.notebooks.get(args.id),
        run: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
            if (!isUuid(args.id)) return null;
            const run = await ctx.runs.get(args.id);
            return run ? serializeRun(run) : null;
        },
        sampleSchema: (_: unknown, __: unknown, ctx: GraphQLContext) => ctx.schema.tables(),
        copilotRequests: async (_: unknown, args: { notebookId: string; limit?: number | null }, ctx: GraphQLContext) => {
            requireUuid(args.notebookId, "notebookId");
            return (await ctx.copilot.list(args.notebookId, args.limit ?? 20)).map((row: CopilotRequestRow) => ({
                ...row,
                proposal: serializeProposal(row.proposal),
                createdAt: row.createdAt.toISOString(),
            }));
        },
        copilotModel: (_: unknown, __: unknown, ctx: GraphQLContext) => ctx.copilot.modelName,
    },
    Subscription: {
        copilot: {
            subscribe: async (_: unknown, args: { input: CopilotInput }, ctx: GraphQLContext) => {
                const input = args.input;
                requireUuid(input.notebookId, "notebookId");
                if (!(await ctx.notebooks.get(input.notebookId))) throw badInput("notebook not found");
                return copilotEvents(ctx.copilot, { ...input, cellId: input.cellId ?? null });
            },
        },
    },
    Mutation: {
        createNotebook: (_: unknown, args: { title: string; fromTemplate?: boolean | null }, ctx: GraphQLContext) => {
            const title = args.title.trim();
            if (title.length === 0 || title.length > 200) throw badInput("title must be 1-200 characters");
            return ctx.notebooks.create(title, args.fromTemplate ? SHOP_ANALYSIS : []);
        },
        runCell: async (_: unknown, args: { notebookId: string; cellId: string }, ctx: GraphQLContext) => {
            requireUuid(args.notebookId, "notebookId");
            if (!(await ctx.notebooks.get(args.notebookId))) throw badInput("notebook not found");
            try {
                return serializeRun(await ctx.runs.runCell(args.notebookId, args.cellId));
            } catch (error) {
                if (error instanceof RunError) throw badInput(error.message);
                throw error;
            }
        },
    },
    Notebook: {
        createdAt: (notebook: NotebookRow) => notebook.createdAt.toISOString(),
        cells: (notebook: NotebookRow, _: unknown, ctx: GraphQLContext): Promise<CellSnapshot[]> =>
            ctx.rooms.withRoom(notebook.id, (room) => readNotebook(room.doc).cells),
        runs: async (notebook: NotebookRow, args: { limit?: number | null }, ctx: GraphQLContext) =>
            (await ctx.runs.listForNotebook(notebook.id, args.limit ?? 20)).map(serializeRun),
    },
};
