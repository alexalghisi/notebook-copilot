import { z } from "zod";
import type { NotebookSnapshot } from "../../shared/notebook.ts";
import type { Proposal } from "../../shared/proposal.ts";
import type { Run } from "../exec/runService.ts";
import type { SchemaCatalog } from "../exec/schema.ts";
import { SqlError, type CellValue, type QueryRunner } from "../exec/sqlRunner.ts";
import { renderTable } from "./context.ts";
import type { ToolCall, ToolSpec } from "./model.ts";

export interface RunLookup {
    latestForCell(notebookId: string, cellId: string): Promise<Run | null>;
}

export interface ToolEnvironment {
    notebookId: string;
    notebook: NotebookSnapshot;
    schema: SchemaCatalog;
    runner: QueryRunner;
    runs: RunLookup;
    /** Rows returned to the model per query; it needs enough to check a result, not all of it. */
    previewRows: number;
}

export interface ToolOutcome {
    /** What the model reads. */
    content: string;
    /** One line for the UI's step log. */
    summary: string;
    isError: boolean;
    proposal?: Proposal;
}

export const TOOL_SPECS: ToolSpec[] = [
    {
        name: "inspect_schema",
        description: "Describe tables of the sample database: columns, types and comments. Omit `table` to list every table.",
        parameters: { type: "object", properties: { table: { type: "string", description: "Table name" } }, additionalProperties: false },
    },
    {
        name: "run_query",
        description: "Run one read-only SQL statement against the sample database and see the first rows, or the error.",
        parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"], additionalProperties: false },
    },
    {
        name: "read_cell_output",
        description: "Read the latest result (first rows or error) of a notebook cell by id.",
        parameters: { type: "object", properties: { cell_id: { type: "string" } }, required: ["cell_id"], additionalProperties: false },
    },
    {
        name: "propose_edit",
        description:
            "Propose new content for a notebook cell. Pass the complete new source, not a fragment. The user reviews a diff and decides whether to apply it.",
        parameters: {
            type: "object",
            properties: {
                cell_id: { type: "string" },
                source: { type: "string", description: "Complete new cell source" },
                explanation: { type: "string", description: "One or two sentences on what changed and why" },
            },
            required: ["cell_id", "source", "explanation"],
            additionalProperties: false,
        },
    },
];

const ARGS = {
    inspect_schema: z.object({ table: z.string().optional() }),
    run_query: z.object({ sql: z.string().min(1) }),
    read_cell_output: z.object({ cell_id: z.string().min(1) }),
    propose_edit: z.object({ cell_id: z.string().min(1), source: z.string(), explanation: z.string().default("") }),
};

export async function executeTool(call: ToolCall, env: ToolEnvironment): Promise<ToolOutcome> {
    if (!(call.name in ARGS)) return failure(`unknown tool ${call.name}`, `unknown tool ${call.name}`);
    let raw: unknown;
    try {
        raw = JSON.parse(call.arguments || "{}");
    } catch {
        return failure("arguments were not valid JSON", `bad arguments for ${call.name}`);
    }
    switch (call.name) {
        case "inspect_schema": {
            const args = ARGS.inspect_schema.safeParse(raw);
            if (!args.success) return invalid(call.name, args.error);
            return inspectSchema(args.data.table, env);
        }
        case "run_query": {
            const args = ARGS.run_query.safeParse(raw);
            if (!args.success) return invalid(call.name, args.error);
            return runQuery(args.data.sql, env);
        }
        case "read_cell_output": {
            const args = ARGS.read_cell_output.safeParse(raw);
            if (!args.success) return invalid(call.name, args.error);
            return readCellOutput(args.data.cell_id, env);
        }
        default: {
            const args = ARGS.propose_edit.safeParse(raw);
            if (!args.success) return invalid(call.name, args.error);
            return proposeEdit(args.data, env);
        }
    }
}

async function inspectSchema(table: string | undefined, env: ToolEnvironment): Promise<ToolOutcome> {
    const tables = await env.schema.tables();
    if (table === undefined) {
        return { content: tables.map(renderTable).join("\n"), summary: `listed ${tables.length} tables`, isError: false };
    }
    const found = tables.find((t) => t.name === table.toLowerCase());
    if (!found) {
        return failure(`no table named ${table}; tables are: ${tables.map((t) => t.name).join(", ")}`, `no table ${table}`);
    }
    return { content: renderTable(found), summary: `described ${found.name}`, isError: false };
}

async function runQuery(sql: string, env: ToolEnvironment): Promise<ToolOutcome> {
    try {
        const result = await env.runner.run(sql, { rowLimit: env.previewRows });
        const table = formatRows(
            result.columns.map((c) => c.name),
            result.rows,
        );
        const more = result.truncated ? ` (showing the first ${result.rowCount}; more rows exist)` : "";
        return {
            content: `${result.rowCount} row${result.rowCount === 1 ? "" : "s"}${more}\n${table}`,
            summary: `query returned ${result.rowCount}${result.truncated ? "+" : ""} rows`,
            isError: false,
        };
    } catch (error) {
        const message = error instanceof SqlError ? error.message : (error as Error).message;
        const where = error instanceof SqlError && error.position ? ` (at character ${error.position})` : "";
        return failure(`ERROR: ${message}${where}`, `query failed: ${message}`);
    }
}

async function readCellOutput(cellId: string, env: ToolEnvironment): Promise<ToolOutcome> {
    if (!env.notebook.cells.some((c) => c.id === cellId)) return failure(`no cell with id ${cellId}`, `no cell ${cellId}`);
    const run = await env.runs.latestForCell(env.notebookId, cellId);
    if (!run) return { content: "The cell has not been run yet.", summary: `cell ${cellId} has no output`, isError: false };
    if (run.status === "failed") return { content: `Last run failed: ${run.error ?? "unknown error"}`, summary: `read error of ${cellId}`, isError: false };
    if (run.status === "running") return { content: "The cell is still running.", summary: `cell ${cellId} is running`, isError: false };
    const rows = run.rows.slice(0, env.previewRows);
    const table = formatRows(
        run.columns.map((c) => c.name),
        rows,
    );
    return { content: `${run.rowCount ?? 0} rows${run.truncated ? " (truncated)" : ""}\n${table}`, summary: `read output of ${cellId}`, isError: false };
}

function proposeEdit(args: { cell_id: string; source: string; explanation: string }, env: ToolEnvironment): ToolOutcome {
    const cell = env.notebook.cells.find((c) => c.id === args.cell_id);
    if (!cell) return failure(`no cell with id ${args.cell_id}`, `no cell ${args.cell_id}`);
    const proposed = args.source.replace(/\s+$/, "");
    if (proposed === cell.source.replace(/\s+$/, "")) return failure("the proposed source is identical to the current source", "proposal made no change");
    return {
        content: "Proposal recorded. The user will review the diff.",
        summary: `proposed an edit to ${cell.id}`,
        isError: false,
        proposal: { cellId: cell.id, base: cell.source, proposed, explanation: args.explanation.trim() },
    };
}

/** Compact pipe-separated rows; long values are clipped so one wide column can't eat the budget. */
export function formatRows(columns: string[], rows: CellValue[][]): string {
    const clip = (value: CellValue) => {
        const text = value === null ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);
        return text.length > 60 ? `${text.slice(0, 57)}...` : text;
    };
    return [columns.join(" | "), ...rows.map((row) => row.map(clip).join(" | "))].join("\n");
}

function failure(content: string, summary: string): ToolOutcome {
    return { content, summary, isError: true };
}

function invalid(tool: string, error: z.ZodError): ToolOutcome {
    return failure(`invalid arguments for ${tool}: ${z.prettifyError(error)}`, `bad arguments for ${tool}`);
}
