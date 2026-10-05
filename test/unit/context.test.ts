import { describe, expect, it } from "vitest";
import { buildContext } from "../../src/server/copilot/context.ts";
import { countTokens } from "../../src/server/copilot/tokens.ts";
import { TABLES, cell, failed, notebook } from "../helpers/fixtures.ts";

const LONG_UNRELATED = cell(
    "noise",
    Array.from({ length: 40 }, (_, i) => `select ${i} as n, 'padding text that has nothing to do with the task' as filler`).join("\nunion all\n"),
);

const NB = notebook([
    cell("intro", "# Shop analysis\nRevenue counts paid and shipped orders.", { type: "markdown" }),
    cell("countries", "select country, count(*) from customers group by country"),
    LONG_UNRELATED,
    cell("revenue", "select p.category, sum(oi.quantity * oi.unit_price)\nfrom order_items oi join products p on p.id = oi.product_id\ngroup by 1"),
    failed("broken", "select date_trunc('month', o.orderd_at), count(*)\nfrom orders o\ngroup by 1", 'column o.orderd_at does not exist'),
]);

function status(packed: ReturnType<typeof buildContext>, id: string) {
    return packed.items.find((item) => item.id === id)?.status ?? "absent";
}

describe("buildContext", () => {
    it("never exceeds the budget, measured with the real tokenizer", () => {
        for (let budget = 0; budget <= 1500; budget += 37) {
            const packed = buildContext({ notebook: NB, focusCellId: "broken", prompt: "fix this cell", tables: TABLES, budgetTokens: budget });
            expect(countTokens(packed.text)).toBe(packed.tokens);
            expect(packed.tokens).toBeLessThanOrEqual(budget);
        }
    });

    it("always includes the focus cell with its last error when there is room", () => {
        const packed = buildContext({ notebook: NB, focusCellId: "broken", prompt: "fix this", tables: TABLES, budgetTokens: 400 });
        expect(status(packed, "broken")).toBe("full");
        expect(packed.text).toContain("[cell broken sql FOCUS]");
        expect(packed.text).toContain("Last run failed: column o.orderd_at does not exist");
    });

    it("prefers schemas of referenced tables over unrelated cells when the budget is tight", () => {
        const packed = buildContext({ notebook: NB, focusCellId: "broken", prompt: "fix this", tables: TABLES, budgetTokens: 260 });
        expect(status(packed, "orders")).toBe("full");
        expect(packed.text).toMatch(/orders\(id integer, customer_id integer, ordered_at timestamp with time zone/);
        expect(status(packed, "noise")).not.toBe("full");
        expect(packed.referencedTables).toEqual(["orders"]);
    });

    it("includes tables the prompt mentions in prose, singular or plural", () => {
        const packed = buildContext({ notebook: NB, focusCellId: null, prompt: "how many orders per customer?", tables: TABLES, budgetTokens: 600 });
        expect(packed.referencedTables.sort()).toEqual(["customers", "orders"]);
        expect(status(packed, "customers")).toBe("full");
    });

    it("ranks cells that share tables and terms above unrelated ones", () => {
        const packed = buildContext({ notebook: NB, focusCellId: null, prompt: "revenue by product category and customer country", tables: TABLES, budgetTokens: 900 });
        const cells = packed.items.filter((i) => i.kind === "cell");
        expect(cells.slice(0, 2).map((c) => c.id).sort()).toEqual(["countries", "revenue"]);
        expect(cells.find((c) => c.id === "revenue")?.reason).toMatch(/uses the same tables/);
        expect(cells.at(-1)?.id).toBe("noise");
    });

    it("renders selected cells in notebook order and says how many were left out", () => {
        const packed = buildContext({ notebook: NB, focusCellId: "broken", prompt: "fix", tables: TABLES, budgetTokens: 420 });
        const positions = ["intro", "countries", "revenue", "broken"]
            .filter((id) => packed.text.includes(`[cell ${id} `))
            .map((id) => packed.text.indexOf(`[cell ${id} `));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        const shown = (packed.text.match(/\[cell /g) ?? []).length;
        expect(packed.text).toContain(`(${5 - shown} other cell`);
    });

    it("truncates an oversized focus cell instead of dropping it, and leaves room for its tables", () => {
        const huge = cell("huge", `select * from orders\nwhere ${Array.from({ length: 300 }, (_, i) => `id <> ${i}`).join("\n  and ")}`);
        const packed = buildContext({ notebook: notebook([huge]), focusCellId: "huge", prompt: "speed this up", tables: TABLES, budgetTokens: 300 });
        expect(status(packed, "huge")).toBe("truncated");
        expect(packed.text).toMatch(/-- \.\.\. \d+ more lines\n```/);
        expect(status(packed, "orders")).toBe("full");
        expect(packed.tokens).toBeLessThanOrEqual(300);
    });

    it("reports every candidate it considered, including what it dropped and why", () => {
        const packed = buildContext({ notebook: NB, focusCellId: "broken", prompt: "fix", tables: TABLES, budgetTokens: 200 });
        const dropped = packed.items.filter((i) => i.status === "dropped");
        expect(dropped.length).toBeGreaterThan(0);
        expect(dropped.every((i) => /did not fit|budget/.test(i.reason))).toBe(true);
        expect(packed.items.map((i) => i.id)).toEqual(expect.arrayContaining(["broken", "orders", "countries", "revenue", "noise", "intro"]));
    });

    it("returns an empty context for a zero budget rather than overflowing", () => {
        const packed = buildContext({ notebook: NB, focusCellId: "broken", prompt: "fix", tables: TABLES, budgetTokens: 0 });
        expect(packed.text).toBe("");
        expect(packed.tokens).toBe(0);
    });
});
