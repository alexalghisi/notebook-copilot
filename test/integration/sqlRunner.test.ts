import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createPool } from "../../src/server/db/pool.ts";
import { PostgresSchemaCatalog } from "../../src/server/exec/schema.ts";
import { SqlError, SqlRunner } from "../../src/server/exec/sqlRunner.ts";
import { READER_URL } from "../helpers/env.ts";

let pool: pg.Pool;
let runner: SqlRunner;

beforeAll(() => {
    pool = createPool(READER_URL, 4);
    runner = new SqlRunner(pool, { statementTimeoutMs: 300, rowLimit: 50 });
});
afterAll(() => pool.end());

async function failure(sql: string): Promise<SqlError> {
    const error = await runner.run(sql).then(
        () => null,
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SqlError);
    return error as SqlError;
}

describe("SqlRunner against the sample database", () => {
    it("returns typed columns and JSON-safe rows", async () => {
        const result = await runner.run("select id, name, price, id > 10 as big from products order by id limit 2;");
        expect(result.columns).toEqual([
            { name: "id", type: "int4" },
            { name: "name", type: "text" },
            { name: "price", type: "numeric" },
            { name: "big", type: "bool" },
        ]);
        expect(result.rows).toEqual([
            [1, "Laptop", "1199.00", false],
            [2, "Monitor", "249.00", false],
        ]);
        expect(result.truncated).toBe(false);
    });

    it("has the same generated data everywhere", async () => {
        const { rows } = await runner.run(
            "select (select count(*) from customers), (select count(*) from products), (select count(*) from orders), (select count(*) from order_items)",
        );
        expect(rows[0]).toEqual([200, 20, 2000, expect.any(Number)]);
    });

    it("stops reading at the row limit and says the result was truncated", async () => {
        const result = await runner.run("select * from orders");
        expect(result.rowCount).toBe(50);
        expect(result.truncated).toBe(true);
        expect((await runner.run("select * from orders", { rowLimit: 5 })).rowCount).toBe(5);
        // A caller can't raise the limit above the configured maximum.
        expect((await runner.run("select * from orders", { rowLimit: 10_000 })).rowCount).toBe(50);
    });

    it("cancels statements that exceed the timeout", async () => {
        const error = await failure("select pg_sleep(2)");
        expect(error.code).toBe("57014");
        expect(error.message).toMatch(/statement timeout/);
    });

    it("cannot write, create objects or run several statements", async () => {
        expect((await failure("insert into products values (99, 'x', 'y', 1)")).code).toBe("25006");
        expect((await failure("create temp table t (x int)")).code).toMatch(/25006|42501/);
        expect((await failure("select 1; delete from orders")).message).toBe("Only one statement per cell is supported.");
        expect((await failure("set transaction read write; select 1")).message).toBe("Only one statement per cell is supported.");
    });

    it("reports error positions relative to the cell text", async () => {
        const sql = "\n\n  select nme from customers";
        const error = await failure(sql);
        expect(error.code).toBe("42703");
        expect(sql.slice(error.position! - 1)).toMatch(/^nme/);
    });

    it("rejects empty and comment-only cells without touching the database", async () => {
        expect((await failure("  -- nothing here\n")).message).toBe("The cell is empty.");
    });

    it("describes tables, columns and comments", async () => {
        const tables = await new PostgresSchemaCatalog(pool).tables();
        expect(tables.map((t) => t.name)).toEqual(["customers", "order_items", "orders", "products"]);
        const orders = tables.find((t) => t.name === "orders")!;
        expect(orders.comment).toMatch(/revenue/);
        expect(orders.columns.map((c) => c.name)).toEqual(["id", "customer_id", "ordered_at", "status"]);
    });
});
