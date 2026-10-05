import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ChatModel } from "../src/server/copilot/model.ts";
import { OfflineModel } from "../src/server/copilot/offline/offlineModel.ts";
import { OpenAIModel } from "../src/server/copilot/openaiModel.ts";
import { priceFor } from "../src/server/copilot/pricing.ts";
import { createPool } from "../src/server/db/pool.ts";
import { PostgresSchemaCatalog } from "../src/server/exec/schema.ts";
import { SqlRunner } from "../src/server/exec/sqlRunner.ts";
import { runTask, summarize, type TaskResult } from "./harness.ts";
import { TASKS } from "./tasks.ts";

const { values } = parseArgs({
    options: {
        model: { type: "string", default: "offline" },
        filter: { type: "string" },
        "min-pass": { type: "string" },
        "context-budget": { type: "string", default: "3000" },
        out: { type: "string", default: join(import.meta.dirname, "out") },
    },
});

function createModel(kind: string): ChatModel {
    if (kind === "offline") return new OfflineModel();
    if (kind === "openai") {
        const apiKey = process.env.LLM_API_KEY;
        if (!apiKey) throw new Error("--model openai needs LLM_API_KEY (and optionally LLM_BASE_URL, LLM_MODEL)");
        return new OpenAIModel({ baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1", apiKey, model: process.env.LLM_MODEL ?? "gpt-4o-mini" });
    }
    throw new Error(`unknown model ${kind}; use offline or openai`);
}

const model = createModel(values.model);
const pool = createPool(process.env.SAMPLE_DATABASE_URL ?? "postgres://dn_reader:dn_reader@localhost:5432/dn_sample", 4);
const deps = {
    runner: new SqlRunner(pool, { statementTimeoutMs: 5_000, rowLimit: 2_000 }),
    schema: new PostgresSchemaCatalog(pool),
    model,
    price: priceFor(model.name),
    contextBudget: Number(values["context-budget"]),
};

const tasks = TASKS.filter((t) => !values.filter || t.id.includes(values.filter));
const results: TaskResult[] = [];
try {
    for (const task of tasks) {
        const result = await runTask(task, deps);
        results.push(result);
        const tokens = `${result.promptTokens}+${result.completionTokens}`;
        console.log(`${result.pass ? "PASS" : "FAIL"}  ${task.id.padEnd(30)} ${String(result.steps).padStart(2)} steps ${tokens.padStart(11)} tok ${String(result.latencyMs).padStart(6)} ms  ${result.pass ? "" : result.reason}`);
    }
} finally {
    await pool.end();
}

const summary = summarize(model.name, results);
console.log(
    `\n${summary.model}: ${summary.passed}/${summary.tasks} passed (${(summary.passRate * 100).toFixed(0)}%), ` +
        `fix ${summary.byKind.fix?.passed ?? 0}/${summary.byKind.fix?.tasks ?? 0}, write ${summary.byKind.write?.passed ?? 0}/${summary.byKind.write?.tasks ?? 0}; ` +
        `${summary.promptTokens} prompt + ${summary.completionTokens} completion tokens, $${summary.costUsd.toFixed(4)}; ` +
        `latency p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms`,
);

await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, `report-${model.name}.json`), JSON.stringify({ summary, results }, null, 2));
const table = [
    "| task | result | steps | prompt tokens | completion tokens | latency ms | note |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...results.map((r) => `| ${r.id} | ${r.pass ? "pass" : "fail"} | ${r.steps} | ${r.promptTokens} | ${r.completionTokens} | ${r.latencyMs} | ${r.pass ? "" : r.reason.replaceAll("|", "\\|")} |`),
].join("\n");
await writeFile(join(values.out, `report-${model.name}.md`), `${table}\n`);

const minPass = values["min-pass"] === undefined ? null : Number(values["min-pass"]);
if (minPass !== null && summary.passRate < minPass) {
    console.error(`pass rate ${summary.passRate.toFixed(2)} is below the required ${minPass}`);
    process.exit(1);
}
