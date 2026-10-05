import { describe, expect, it } from "vitest";
import { compareResults, normalize } from "../../evals/score.ts";

const gold = { columns: ["category", "revenue"], rows: [["Electronics", "1200.50"], ["Grocery", "80.00"]] };

describe("eval scoring", () => {
    it("normalizes numbers and numeric strings to two decimals", () => {
        expect(normalize("1200.5")).toBe("1200.50");
        expect(normalize(3)).toBe("3.00");
        expect(normalize(null)).toBe("NULL");
        expect(normalize("2025-01-01T00:00:00.000Z")).toBe("2025-01-01T00:00:00.000Z");
    });

    it("ignores column names, column order and row order for unordered tasks", () => {
        const produced = { columns: ["total", "cat"], rows: [[80, "Grocery"], [1200.5, "Electronics"]] };
        expect(compareResults(gold, produced, false)).toEqual({ pass: true, reason: "results match" });
    });

    it("allows extra columns", () => {
        const produced = { columns: ["category", "orders", "revenue"], rows: [["Electronics", 4, "1200.50"], ["Grocery", 9, "80.00"]] };
        expect(compareResults(gold, produced, true).pass).toBe(true);
    });

    it("checks row order for ordered tasks", () => {
        const reversed = { columns: gold.columns, rows: [...gold.rows].reverse() };
        expect(compareResults(gold, reversed, false).pass).toBe(true);
        expect(compareResults(gold, reversed, true)).toMatchObject({ pass: false });
    });

    it("fails on different row counts and on values that don't line up across columns", () => {
        expect(compareResults(gold, { columns: gold.columns, rows: gold.rows.slice(0, 1) }, false).reason).toBe("expected 2 rows, got 1");
        // Both columns exist, but each category got the other one's revenue.
        const swapped = { columns: gold.columns, rows: [["Electronics", "80.00"], ["Grocery", "1200.50"]] };
        expect(compareResults(gold, swapped, false)).toEqual({ pass: false, reason: "same columns, but rows differ" });
        expect(compareResults(gold, { columns: ["x", "y"], rows: [["a", 1], ["b", 2]] }, false).pass).toBe(false);
    });

    it("finds the right mapping when several columns hold the same values", () => {
        const g = { columns: ["a", "b"], rows: [[1, 2], [2, 1]] };
        const p = { columns: ["x", "y"], rows: [[2, 1], [1, 2]] };
        expect(compareResults(g, p, true).pass).toBe(true);
    });
});
