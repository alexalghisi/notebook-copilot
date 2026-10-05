import type { CellSnapshot, NotebookSnapshot } from "../../shared/notebook.ts";
import type { TableSchema } from "../exec/schema.ts";
import { tableRefs, tablesMentioned, wordsOf } from "./sqlRefs.ts";
import { countTokens, truncateToTokens } from "./tokens.ts";

export interface ContextRequest {
    notebook: NotebookSnapshot;
    focusCellId: string | null;
    prompt: string;
    tables: readonly TableSchema[];
    budgetTokens: number;
}

export type ItemStatus = "full" | "truncated" | "dropped";

export interface ContextItemReport {
    kind: "cell" | "table";
    id: string;
    tokens: number;
    status: ItemStatus;
    reason: string;
}

export interface PackedContext {
    text: string;
    tokens: number;
    budgetTokens: number;
    items: ContextItemReport[];
    /** Tables the focus cell or prompt refer to, whether or not their schema fit. */
    referencedTables: string[];
}

interface Candidate {
    kind: "cell" | "table";
    id: string;
    tier: number;
    score: number;
    reason: string;
    full: string;
    /** Notebook position for cells, so selected cells render in their real order. */
    order: number;
    truncatable: boolean;
}

interface Chosen {
    candidate: Candidate;
    text: string;
    status: Exclude<ItemStatus, "dropped">;
}

// Below this, a truncated cell is mostly ellipsis and not worth its tokens.
const MIN_USEFUL_TOKENS = 24;
// The focus cell may use most of the budget, but not all of it: its tables matter too.
const FOCUS_SHARE = 0.6;

/**
 * Picks what the model sees about the notebook, within a token budget.
 *
 * Candidates are ranked in tiers: the focus cell (with its last error) first, then the
 * schemas of tables the focus cell or the prompt refer to, then other cells by relevance,
 * then schemas of tables those cells use. Within a tier, higher relevance wins. Packing is
 * greedy: an item that doesn't fit is truncated if a useful prefix fits, otherwise dropped
 * and reported. The rendered text is measured with the real tokenizer at the end, and the
 * lowest-ranked item is removed until the whole thing fits, so the budget is a hard limit.
 */
export function buildContext(request: ContextRequest): PackedContext {
    const { notebook, focusCellId, prompt, tables } = request;
    const budget = Math.max(0, Math.floor(request.budgetTokens));
    const tableNames = tables.map((t) => t.name);
    const focusIndex = notebook.cells.findIndex((c) => c.id === focusCellId);
    const focus = focusIndex >= 0 ? notebook.cells[focusIndex]! : null;

    const focusTables = new Set(focus && focus.type === "sql" ? tableRefs(focus.source).map((r) => r.table) : []);
    for (const name of tablesMentioned(prompt, tableNames)) focusTables.add(name);
    const primaryTables = tableNames.filter((name) => focusTables.has(name));
    const queryWords = wordsOf(`${prompt}\n${focus?.source ?? ""}`);

    const candidates: Candidate[] = [];
    if (focus) {
        candidates.push({ kind: "cell", id: focus.id, tier: 0, score: Infinity, reason: "focus cell", full: renderCell(focus, true), order: focusIndex, truncatable: true });
    }
    for (const table of tables) {
        if (focusTables.has(table.name)) {
            candidates.push({ kind: "table", id: table.name, tier: 1, score: 1, reason: "referenced by the focus cell or prompt", full: renderTable(table), order: 0, truncatable: false });
        }
    }
    notebook.cells.forEach((cell, index) => {
        if (cell === focus || cell.source.trim() === "") return;
        const { score, reason } = relevance(cell, index, focusIndex, notebook.cells.length, queryWords, focusTables);
        candidates.push({ kind: "cell", id: cell.id, tier: 2, score, reason, full: renderCell(cell, false), order: index, truncatable: true });
    });

    const ranked = [...candidates].sort((a, b) => a.tier - b.tier || b.score - a.score || a.order - b.order);
    const chosen: Chosen[] = [];
    const reports = new Map<string, ContextItemReport>();
    const key = (c: Candidate) => `${c.kind}:${c.id}`;
    let used = countTokens(frame(notebook.title, [], [], 0));

    const offer = (candidate: Candidate): void => {
        const cost = countTokens(candidate.full) + 2;
        const remaining = budget - used;
        const cap = candidate.tier === 0 ? Math.min(remaining, Math.floor(budget * FOCUS_SHARE)) : remaining;
        if (cost <= cap) {
            chosen.push({ candidate, text: candidate.full, status: "full" });
            used += cost;
            reports.set(key(candidate), { kind: candidate.kind, id: candidate.id, tokens: cost, status: "full", reason: candidate.reason });
        } else if (candidate.truncatable && cap >= MIN_USEFUL_TOKENS) {
            const text = truncateBlock(candidate.full, cap - 2);
            const tokens = countTokens(text) + 2;
            chosen.push({ candidate, text, status: "truncated" });
            used += tokens;
            reports.set(key(candidate), { kind: candidate.kind, id: candidate.id, tokens, status: "truncated", reason: candidate.reason });
        } else {
            reports.set(key(candidate), { kind: candidate.kind, id: candidate.id, tokens: cost, status: "dropped", reason: `${candidate.reason}; did not fit` });
        }
    };

    ranked.forEach(offer);

    // Tables used by the cells that made it in, if there is room left for them.
    const included = new Set(chosen.map((c) => key(c.candidate)));
    const secondary = new Set<string>();
    for (const c of chosen) {
        if (c.candidate.kind !== "cell") continue;
        const cell = notebook.cells.find((x) => x.id === c.candidate.id);
        if (cell?.type === "sql") tableRefs(cell.source).forEach((r) => secondary.add(r.table));
    }
    for (const table of tables) {
        if (secondary.has(table.name) && !included.has(`table:${table.name}`) && !reports.has(`table:${table.name}`)) {
            offer({ kind: "table", id: table.name, tier: 3, score: 0, reason: "used by an included cell", full: renderTable(table), order: 0, truncatable: false });
        }
    }

    // Enforce the budget on the exact rendering; per-item counts can drift by a token or two at the joins.
    let text = render(notebook, chosen);
    let tokens = countTokens(text);
    while (tokens > budget && chosen.length > 0) {
        const victim = chosen.reduce((worst, c) => (rank(c.candidate) > rank(worst.candidate) ? c : worst));
        chosen.splice(chosen.indexOf(victim), 1);
        const report = reports.get(key(victim.candidate));
        if (report) Object.assign(report, { status: "dropped", reason: `${report.reason}; removed to stay within budget` });
        text = render(notebook, chosen);
        tokens = countTokens(text);
    }
    if (tokens > budget) {
        text = "";
        tokens = 0;
    }

    const order = new Map(ranked.map((c, i) => [key(c), i]));
    return {
        text,
        tokens,
        budgetTokens: budget,
        items: [...reports.values()].sort((a, b) => (order.get(`${a.kind}:${a.id}`) ?? 1e9) - (order.get(`${b.kind}:${b.id}`) ?? 1e9)),
        referencedTables: primaryTables,
    };
}

function rank(candidate: Candidate): number {
    return candidate.tier * 1_000_000 - (Number.isFinite(candidate.score) ? candidate.score : 1e6);
}

function relevance(
    cell: CellSnapshot,
    index: number,
    focusIndex: number,
    cellCount: number,
    queryWords: Set<string>,
    focusTables: Set<string>,
): { score: number; reason: string } {
    const words = wordsOf(cell.source);
    let shared = 0;
    for (const word of words) if (queryWords.has(word)) shared++;
    const overlap = shared / Math.sqrt(words.size + 1);
    const proximity = focusIndex >= 0 ? 1 / (1 + Math.abs(index - focusIndex)) : (0.5 * (index + 1)) / cellCount;
    const failed = cell.output?.status === "failed";
    const sharesTable = cell.type === "sql" && tableRefs(cell.source).some((r) => focusTables.has(r.table));
    const score = 2 * overlap + proximity + (failed ? 0.5 : 0) + (sharesTable ? 1 : 0);
    const reasons = [
        sharesTable ? "uses the same tables" : null,
        shared > 0 ? `${shared} shared term${shared === 1 ? "" : "s"}` : null,
        failed ? "has a recent error" : null,
        focusIndex >= 0 && Math.abs(index - focusIndex) === 1 ? "next to the focus cell" : null,
    ].filter((r): r is string => r !== null);
    return { score, reason: reasons.join(", ") || "notebook cell" };
}

export function renderCell(cell: CellSnapshot, isFocus: boolean): string {
    const lang = cell.type === "sql" ? "sql" : "markdown";
    const header = `[cell ${cell.id} ${cell.type}${isFocus ? " FOCUS" : ""}]`;
    const lines = [header, "```" + lang, cell.source, "```"];
    const output = cell.output;
    if (output?.status === "failed" && output.error) lines.push(`Last run failed: ${output.error}`);
    else if (output?.status === "succeeded") lines.push(`Last run: ${output.rowCount ?? 0} rows`);
    return lines.join("\n");
}

export function renderTable(table: TableSchema): string {
    const columns = table.columns.map((c) => `${c.name} ${c.type}${c.nullable ? " nullable" : ""}`).join(", ");
    const notes = [table.comment, ...table.columns.filter((c) => c.comment).map((c) => `${c.name}: ${c.comment}`)].filter(Boolean);
    return `${table.name}(${columns})${notes.length ? ` -- ${notes.join("; ")}` : ""}`;
}

/** Keeps whole lines from the top of a fenced block, then closes the fence. */
function truncateBlock(block: string, maxTokens: number): string {
    const lines = block.split("\n");
    const closing = lines.findLastIndex((line) => line === "```");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (i === closing) break;
        const omitted = closing - i;
        const candidate = [...kept, lines[i]!, `-- ... ${omitted - 1} more lines`, "```"].join("\n");
        if (countTokens(candidate) > maxTokens) break;
        kept.push(lines[i]!);
    }
    const omitted = closing - kept.length;
    const text = [...kept, `-- ... ${omitted} more lines`, "```"].join("\n");
    // A single very long line can still exceed the cap; fall back to a hard token cut.
    return countTokens(text) <= maxTokens ? text : truncateToTokens(text, maxTokens);
}

function frame(title: string, tables: string[], cells: string[], omitted: number): string {
    const parts: string[] = [];
    if (tables.length) parts.push(`## Tables\n${tables.join("\n")}`);
    const notebook = [`## Notebook "${title}"`, ...cells];
    if (omitted > 0) notebook.push(`(${omitted} other cell${omitted === 1 ? "" : "s"} not shown)`);
    parts.push(notebook.join("\n\n"));
    return parts.join("\n\n");
}

function render(notebook: NotebookSnapshot, chosen: Chosen[]): string {
    const tables = chosen
        .filter((c) => c.candidate.kind === "table")
        .sort((a, b) => a.candidate.id.localeCompare(b.candidate.id))
        .map((c) => c.text);
    const cells = chosen.filter((c) => c.candidate.kind === "cell").sort((a, b) => a.candidate.order - b.candidate.order);
    const shown = new Set(cells.map((c) => c.candidate.id));
    const omitted = notebook.cells.filter((c) => c.source.trim() !== "" && !shown.has(c.id)).length;
    return frame(notebook.title, tables, cells.map((c) => c.text), omitted);
}
