import type { ChatMessage, ChatModel, ModelEvent, ModelRequest, ToolCall } from "../model.ts";
import { questionToSql } from "./nl2sql.ts";
import { parseSchemaText, repairSql, type SchemaInfo } from "./repair.ts";

/**
 * A deterministic stand-in for an LLM, so the app, tests, CI evals and demos run without
 * an API key. It reads the same prompt a real model gets (context, task line, tool
 * results) and drives the same tools: inspect the schema, run a candidate query, repair it
 * from the error, propose the edit once a query runs. Its SQL comes from error-driven
 * repairs and a small question-to-SQL planner, not from understanding, and the eval
 * suite shows where that runs out.
 */
export class OfflineModel implements ChatModel {
    readonly name = "offline";

    constructor(private readonly options: { chunkDelayMs?: number } = {}) {}

    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        const decision = decide(request.messages);
        for (const piece of decision.text.match(/\S+\s*|\s+/g) ?? []) {
            if (request.signal?.aborted) throw request.signal.reason;
            yield { type: "text", delta: piece };
            if (this.options.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.chunkDelayMs));
        }
        for (const call of decision.calls) yield { type: "tool_call", call };
        yield { type: "finish", reason: decision.calls.length ? "tool_calls" : "stop" };
    }
}

interface Decision {
    text: string;
    calls: ToolCall[];
}

interface CellBlock {
    id: string;
    type: string;
    source: string;
    error: string | null;
    focus: boolean;
}

interface ToolExchange {
    name: string;
    args: Record<string, unknown>;
    result: string;
    /** What the model said when it made the call, e.g. the reason for a repair. */
    note: string | null;
}

function decide(messages: ChatMessage[]): Decision {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const cells = parseCells(user);
    const history = exchanges(messages);
    const schemaResult = [...history].reverse().find((h) => h.name === "inspect_schema");
    const schema = schemaResult ? parseSchemaText(schemaResult.result) : null;
    const step = history.length;

    const edit = /Task: edit cell (\S+)\. ([\s\S]*)$/.exec(user);
    if (edit) return decideEdit(edit[1]!, edit[2]!.trim(), cells, schema, history, step);
    const question = /Question: ([\s\S]*)$/.exec(user)?.[1]?.trim() ?? "";
    return decideAsk(question, cells, schema, history, step);
}

function decideEdit(cellId: string, prompt: string, cells: CellBlock[], schema: SchemaInfo | null, history: ToolExchange[], step: number): Decision {
    const cell = cells.find((c) => c.id === cellId);
    if (!schema) return call(step, "Checking the tables this cell uses.", "inspect_schema", {});

    const lastRun = [...history].reverse().find((h) => h.name === "run_query");
    if (!lastRun) {
        if (cell?.error && cell.source.trim()) {
            const repair = repairSql(cell.source, cell.error, schema);
            if (!repair) return say(`I couldn't work out a fix for this error: ${cell.error}`);
            return call(step, `${repair.note} Trying the corrected query.`, "run_query", { sql: repair.sql });
        }
        const sql = questionToSql(prompt);
        if (!sql) return say("I couldn't turn that request into a query over the shop tables. Try naming a measure (revenue, orders, customers) and how to group it.");
        return call(step, "Drafting the query and running it to check the result.", "run_query", { sql });
    }

    const sql = String(lastRun.args.sql ?? "");
    if (lastRun.result.startsWith("ERROR:")) {
        const repair = repairSql(sql, lastRun.result.replace(/^ERROR:\s*/, ""), schema);
        if (!repair) return say(`The query still fails and I don't have another fix: ${lastRun.result.replace(/^ERROR:\s*/, "")}`);
        return call(step, `${repair.note} Running it again.`, "run_query", { sql: repair.sql });
    }

    const rows = /^(\d+) rows?/.exec(lastRun.result)?.[1] ?? "?";
    const notes = history
        .filter((h) => h.name === "run_query")
        .map((h) => h.note)
        .filter((n): n is string => Boolean(n));
    const explanation = cell?.error ? notes.join(" ") || "Fixed the error." : `Wrote a query for: ${prompt}`;
    return call(step, `The query runs and returns ${rows} rows. Proposing the change.`, "propose_edit", {
        cell_id: cellId,
        source: sql,
        explanation,
    });
}

function decideAsk(question: string, cells: CellBlock[], schema: SchemaInfo | null, history: ToolExchange[], step: number): Decision {
    const q = question.toLowerCase();
    const failing = cells.find((c) => c.focus && c.error) ?? cells.find((c) => c.error);

    if (/\b(why|wrong|error|fail|broken)\b/.test(q) && failing) {
        if (!schema) return call(step, "Looking at the schema first.", "inspect_schema", {});
        const repair = repairSql(failing.source, failing.error!, schema);
        return say(
            `Cell ${failing.id} fails with: ${failing.error}\n\n` +
                (repair ? `${repair.note} Use "Fix" on the cell to get a proposed edit.` : "I don't see an obvious fix from the schema."),
        );
    }

    const lastRun = [...history].reverse().find((h) => h.name === "run_query");
    if (lastRun) {
        return say(answerFromRows(String(lastRun.args.sql ?? ""), lastRun.result));
    }
    const sql = questionToSql(question);
    if (sql) return call(step, "Let me query that.", "run_query", { sql });

    if (/\b(what|summar|explain|describe|overview)\b/.test(q)) {
        const sqlCells = cells.filter((c) => c.type === "sql");
        const lines = sqlCells.map((c) => {
            const tables = [...c.source.matchAll(/\b(?:from|join)\s+(\w+)/gi)].map((m) => m[1]!.toLowerCase());
            return `- ${c.id}: reads ${[...new Set(tables)].join(", ") || "no tables"}${c.error ? " (currently failing)" : ""}`;
        });
        return say(`This notebook has ${cells.length} cells in view, ${sqlCells.length} of them SQL:\n${lines.join("\n")}`);
    }
    return say("I can answer questions that map to a query over customers, orders, order_items and products, for example \"revenue by category\" or \"top 5 customers by spend\".");
}

function answerFromRows(sql: string, result: string): string {
    if (result.startsWith("ERROR:")) return `The query failed: ${result.slice(6).trim()}`;
    const [summary, header, ...rows] = result.split("\n");
    const columns = (header ?? "").split(" | ");
    const shown = rows.slice(0, 5);
    const table = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...shown.map((r) => `| ${r} |`)].join("\n");
    const lead = rows.length === 1 && columns.length === 1 ? `The answer is ${rows[0]}.` : `${summary}. The first ${shown.length}:`;
    return `${lead}\n\n${table}\n\nQuery:\n\`\`\`sql\n${sql}\n\`\`\``;
}

function parseCells(context: string): CellBlock[] {
    const cells: CellBlock[] = [];
    const pattern = /\[cell (\S+) (sql|markdown)( FOCUS)?\]\n```\w*\n([\s\S]*?)\n```(?:\nLast run failed: ([^\n]*))?/g;
    for (const match of context.matchAll(pattern)) {
        cells.push({ id: match[1]!, type: match[2]!, focus: Boolean(match[3]), source: match[4]!, error: match[5] ?? null });
    }
    return cells;
}

function exchanges(messages: ChatMessage[]): ToolExchange[] {
    const out: ToolExchange[] = [];
    for (const [i, message] of messages.entries()) {
        if (message.role !== "assistant" || !message.toolCalls) continue;
        for (const toolCall of message.toolCalls) {
            const result = messages.slice(i + 1).find((m) => m.role === "tool" && m.toolCallId === toolCall.id);
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
            } catch {
                // a malformed call of our own would be a bug; treat it as empty
            }
            const note = message.content.replace(/ (Trying the corrected query|Running it again)\.$/, "").trim();
            out.push({ name: toolCall.name, args, result: result?.role === "tool" ? result.content : "", note: note && !/^(Checking|Drafting|Looking|Let me)/.test(note) ? note : null });
        }
    }
    return out;
}

function call(step: number, text: string, name: string, args: Record<string, unknown>): Decision {
    return { text, calls: [{ id: `offline_${step}_${name}`, name, arguments: JSON.stringify(args) }] };
}

function say(text: string): Decision {
    return { text, calls: [] };
}
