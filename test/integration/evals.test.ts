import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { runTask, summarize, type EvalDeps } from "../../evals/harness.ts";
import { TASKS } from "../../evals/tasks.ts";
import { OfflineModel } from "../../src/server/copilot/offline/offlineModel.ts";
import { OpenAIModel } from "../../src/server/copilot/openaiModel.ts";
import { createPool } from "../../src/server/db/pool.ts";
import { PostgresSchemaCatalog } from "../../src/server/exec/schema.ts";
import { SqlRunner } from "../../src/server/exec/sqlRunner.ts";
import { READER_URL } from "../helpers/env.ts";
import { chunk, startFakeOpenAI } from "../helpers/fakeOpenAI.ts";

let pool: pg.Pool;
let base: Omit<EvalDeps, "model" | "price">;

beforeAll(() => {
    pool = createPool(READER_URL, 4);
    base = { runner: new SqlRunner(pool, { statementTimeoutMs: 5_000, rowLimit: 2_000 }), schema: new PostgresSchemaCatalog(pool), contextBudget: 3_000 };
});
afterAll(() => pool.end());

describe("eval suite", () => {
    it("has 25 tasks with unique ids, runnable gold queries and fix cells that really fail", async () => {
        expect(TASKS).toHaveLength(25);
        expect(new Set(TASKS.map((t) => t.id)).size).toBe(25);
        for (const task of TASKS) {
            const gold = await base.runner.run(task.gold, { rowLimit: 2_000 });
            expect(gold.rowCount, task.id).toBeGreaterThan(0);
            expect(gold.truncated, task.id).toBe(false);
            if (task.kind === "fix") await expect(base.runner.run(task.cell), task.id).rejects.toThrow();
        }
    });

    it("keeps the offline model's pass rate from regressing", async () => {
        const model = new OfflineModel();
        const results = [];
        for (const task of TASKS) results.push(await runTask(task, { ...base, model, price: { input: 0, output: 0 } }));
        const summary = summarize(model.name, results);
        expect(summary.passRate).toBeGreaterThanOrEqual(0.88);
        expect(results.every((r) => r.contextTokens <= 3_000)).toBe(true);
        // Failures should be the tasks that need understanding, not plumbing errors.
        expect(results.filter((r) => !r.pass).map((r) => r.id).sort()).toEqual(["fix-semantic-column", "fix-type-mismatch", "write-cancelled-share"]);
    });

    it("scores a remote model's answer through the same harness", async () => {
        const fake = await startFakeOpenAI();
        try {
            const task = TASKS.find((t) => t.id === "fix-semantic-column")!;
            const args = JSON.stringify({ cell_id: "task", source: "select name, price\nfrom products\norder by price desc\nlimit 3", explanation: "cost is called price" });
            fake.enqueue({
                kind: "stream",
                chunks: [chunk.text("The column is called price."), chunk.toolStart(0, "c1", "propose_edit"), chunk.toolArgs(0, args), chunk.finish("tool_calls"), chunk.usage(900, 40)],
            });
            const model = new OpenAIModel({ baseUrl: fake.url, apiKey: "k", model: "gpt-4o-mini" });
            const result = await runTask(task, { ...base, model, price: { input: 0.15, output: 0.6 } });
            expect(result).toMatchObject({ pass: true, stopReason: "proposal", promptTokens: 900, completionTokens: 40 });
            expect(result.costUsd).toBeCloseTo((900 * 0.15 + 40 * 0.6) / 1e6, 10);
            const sent = fake.requests[0]!.body.messages as Array<{ role: string; content: string }>;
            expect(sent[1]!.content).toContain("Last run failed: column \"cost\" does not exist");
        } finally {
            await fake.close();
        }
    });
});
