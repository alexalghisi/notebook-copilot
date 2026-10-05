import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool } from "../../src/server/db/pool.ts";
import { renderTable } from "../../src/server/copilot/context.ts";
import { parseSchemaText, repairSql, type SchemaInfo } from "../../src/server/copilot/offline/repair.ts";
import { questionToSql } from "../../src/server/copilot/offline/nl2sql.ts";
import { PostgresSchemaCatalog } from "../../src/server/exec/schema.ts";
import { SqlError, SqlRunner } from "../../src/server/exec/sqlRunner.ts";
import { READER_URL } from "../helpers/env.ts";

let pool: pg.Pool;
let runner: SqlRunner;
let schema: SchemaInfo;

beforeAll(async () => {
    pool = createPool(READER_URL, 2);
    runner = new SqlRunner(pool, { statementTimeoutMs: 2_000, rowLimit: 100 });
    schema = parseSchemaText((await new PostgresSchemaCatalog(pool).tables()).map(renderTable).join("\n"));
});
afterAll(() => pool.end());

async function errorOf(sql: string): Promise<string> {
    try {
        await runner.run(sql);
    } catch (error) {
        if (error instanceof SqlError) return error.message;
    }
    throw new Error(`expected ${sql} to fail`);
}

// Each case is fixed using the error Postgres actually reports, then checked by running it.
const CASES: Array<[string, string, string]> = [
    ["misspelled qualified column", "select date_trunc('month', o.orderd_at), count(*) from orders o group by 1", "o.ordered_at"],
    ["misspelled table", "select country, count(*) from customer group by country", "from customers"],
    ["aggregate without group by", "select country, count(*) from customers", "group by"],
    ["misspelled keyword", "selct name, price from products order by price desc limit 5", "select name"],
    ["unknown alias", "select c.name, count(*) from orders o join customers c on c.id = o.customer_id group by cc.name", "group by c.name"],
    ["ambiguous column", "select id, name from orders o join customers c on c.id = o.customer_id limit 10", "select o.id"],
    ["group without by", "select category, avg(price) from products group category", "group by category"],
    ["unknown function", "select country, cont(*) from customers group by country", "count(*)"],
];

describe("offline repairs against real Postgres errors", () => {
    it.each(CASES)("fixes a %s", async (_name, broken, expected) => {
        const error = await errorOf(broken);
        let sql = broken;
        let current = error;
        // Some fixes reveal the next error; allow a couple of rounds like the agent does.
        for (let round = 0; round < 3; round++) {
            const repair = repairSql(sql, current, schema);
            expect(repair, `no repair for: ${current}`).not.toBeNull();
            sql = repair!.sql;
            try {
                await runner.run(sql);
                break;
            } catch (e) {
                current = (e as SqlError).message;
            }
        }
        await expect(runner.run(sql)).resolves.toBeTruthy();
        expect(sql).toContain(expected);
    });

    it("gives up on errors it has no rule for", async () => {
        const error = await errorOf("select name, cost from products");
        expect(repairSql("select name, cost from products", error, schema)).toBeNull();
    });

    it.each([
        "how many customers are there in each country?",
        "top 5 products by revenue",
        "total revenue by category",
        "number of orders per month",
        "average order value by country",
        "how many orders were refunded?",
        "which 10 customers spent the most?",
        "count of orders by status",
        "list products in the Electronics category ordered by price",
        "customers who never placed an order",
        "revenue per month in 2025",
    ])("plans runnable SQL for %j", async (question) => {
        const sql = questionToSql(question);
        expect(sql).not.toBeNull();
        const result = await runner.run(sql!);
        expect(result.rowCount).toBeGreaterThan(0);
    });
});
