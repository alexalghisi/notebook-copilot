import { GraphQLScalarType, valueFromASTUntyped, type GraphQLError } from "graphql";
import { createGraphQLError } from "graphql-yoga";
import { readNotebook, type CellSnapshot } from "../../shared/notebook.ts";
import type { RoomManager } from "../collab/roomManager.ts";
import { RunError, type Run, type RunService } from "../exec/runService.ts";
import type { SchemaCatalog } from "../exec/schema.ts";
import { isUuid, type NotebookRepo, type NotebookRow } from "../notebooks.ts";
import { SHOP_ANALYSIS } from "../templates.ts";

export interface GraphQLContext {
    notebooks: NotebookRepo;
    runs: RunService;
    rooms: RoomManager;
    schema: SchemaCatalog;
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
