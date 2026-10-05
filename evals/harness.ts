import type { AgentLimits, AgentResult } from "../src/server/copilot/agent.ts";
import type { ChatModel } from "../src/server/copilot/model.ts";
import type { Price } from "../src/server/copilot/pricing.ts";
import { runSession } from "../src/server/copilot/session.ts";
import type { Run } from "../src/server/exec/runService.ts";
import type { SchemaCatalog } from "../src/server/exec/schema.ts";
import { SqlError, type QueryRunner } from "../src/server/exec/sqlRunner.ts";
import { SHOP_ANALYSIS } from "../src/server/templates.ts";
import type { CellSnapshot, NotebookSnapshot } from "../src/shared/notebook.ts";
import { compareResults } from "./score.ts";
import type { EvalTask } from "./tasks.ts";

export interface EvalDeps {
    runner: QueryRunner;
    schema: SchemaCatalog;
    model: ChatModel;
    price: Price;
    contextBudget: number;
    limits?: Partial<AgentLimits>;
}

export interface TaskResult {
    id: string;
    kind: EvalTask["kind"];
    pass: boolean;
    reason: string;
    stopReason: AgentResult["stopReason"];
    steps: number;
    promptTokens: number;
    completionTokens: number;
    contextTokens: number;
    costUsd: number;
    latencyMs: number;
    proposed: string | null;
}

const TASK_CELL = "task";
const RESULT_LIMIT = 2_000;

/**
 * Runs one task the way the app would: the task cell sits in a realistic notebook (the
 * template's first cells), a broken cell carries the error Postgres actually reports, and
 * the copilot goes through the same session code as live requests.
 */
export async function runTask(task: EvalTask, deps: EvalDeps): Promise<TaskResult> {
    const { notebook, failedRun } = await taskNotebook(task, deps.runner);
    const runs = { latestForCell: async (_: string, cellId: string) => (cellId === TASK_CELL ? failedRun : null) };
    const started = performance.now();
    let contextTokens = 0;
    const session = runSession(
        { schema: deps.schema, runner: deps.runner, runs, model: deps.model, price: deps.price, contextBudget: deps.contextBudget, ...(deps.limits ? { limits: deps.limits } : {}) },
        { notebookId: "eval", notebook, action: "edit", prompt: task.prompt, cellId: TASK_CELL },
    );
    let result: AgentResult;
    for (;;) {
        const next = await session.next();
        if (next.done) {
            result = next.value;
            break;
        }
        if ("kind" in next.value) contextTokens = next.value.tokens;
    }
    const latencyMs = Math.round(performance.now() - started);
    const proposed = result.proposal?.proposed ?? null;
    const base = {
        id: task.id,
        kind: task.kind,
        stopReason: result.stopReason,
        steps: result.steps,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        contextTokens,
        costUsd: result.usage.costUsd,
        latencyMs,
        proposed,
    };
    if (!proposed) return { ...base, pass: false, reason: result.error ?? `no edit proposed (${result.stopReason})` };
    return { ...base, ...(await score(task, proposed, deps.runner)) };
}

async function score(task: EvalTask, proposed: string, runner: QueryRunner): Promise<{ pass: boolean; reason: string }> {
    const gold = await runner.run(task.gold, { rowLimit: RESULT_LIMIT });
    let produced;
    try {
        produced = await runner.run(proposed, { rowLimit: RESULT_LIMIT });
    } catch (error) {
        return { pass: false, reason: `proposed SQL fails: ${(error as Error).message}` };
    }
    if (produced.truncated) return { pass: false, reason: "result too large" };
    return compareResults(
        { columns: gold.columns.map((c) => c.name), rows: gold.rows },
        { columns: produced.columns.map((c) => c.name), rows: produced.rows },
        task.ordered,
    );
}

export async function taskNotebook(task: EvalTask, runner: QueryRunner): Promise<{ notebook: NotebookSnapshot; failedRun: Run | null }> {
    const context: CellSnapshot[] = SHOP_ANALYSIS.slice(0, 3).map((cell, i) => ({ id: `ctx${i + 1}`, type: cell.type, source: cell.source, output: null }));
    let failedRun: Run | null = null;
    const cell: CellSnapshot = { id: TASK_CELL, type: "sql", source: task.cell, output: null };
    if (task.kind === "fix") {
        const error = await runner.run(task.cell).then(
            () => null,
            (e: unknown) => (e instanceof SqlError ? e : null),
        );
        if (!error) throw new Error(`fix task ${task.id} doesn't fail`);
        cell.output = { runId: "eval-run", status: "failed", rowCount: null, error: error.message, durationMs: 1, finishedAt: null };
        failedRun = {
            id: "eval-run",
            notebookId: "eval",
            cellId: TASK_CELL,
            source: task.cell,
            status: "failed",
            columns: [],
            rows: [],
            rowCount: null,
            truncated: false,
            error: error.message,
            errorPosition: error.position,
            durationMs: 1,
            startedAt: new Date(),
            finishedAt: new Date(),
        };
    }
    return { notebook: { title: "Shop analysis", cells: [...context, cell] }, failedRun };
}

export interface EvalSummary {
    model: string;
    tasks: number;
    passed: number;
    passRate: number;
    byKind: Record<string, { tasks: number; passed: number }>;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    latencyMs: { p50: number; p95: number; max: number };
}

export function summarize(model: string, results: TaskResult[]): EvalSummary {
    const passed = results.filter((r) => r.pass).length;
    const byKind: EvalSummary["byKind"] = {};
    for (const r of results) {
        const k = (byKind[r.kind] ??= { tasks: 0, passed: 0 });
        k.tasks += 1;
        if (r.pass) k.passed += 1;
    }
    const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
    const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? 0;
    return {
        model,
        tasks: results.length,
        passed,
        passRate: results.length ? passed / results.length : 0,
        byKind,
        promptTokens: results.reduce((n, r) => n + r.promptTokens, 0),
        completionTokens: results.reduce((n, r) => n + r.completionTokens, 0),
        costUsd: results.reduce((n, r) => n + r.costUsd, 0),
        latencyMs: { p50: pct(0.5), p95: pct(0.95), max: latencies.at(-1) ?? 0 },
    };
}
