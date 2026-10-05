import type { CellValue } from "../src/server/exec/sqlRunner.ts";

export interface ResultSet {
    columns: string[];
    rows: CellValue[][];
}

export interface Comparison {
    pass: boolean;
    reason: string;
}

/** Numbers (including numeric strings from Postgres) compare at two decimals; everything else as text. */
export function normalize(value: CellValue): string {
    if (value === null) return "NULL";
    if (typeof value === "number") return value.toFixed(2);
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value).toFixed(2);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

/**
 * Execution match with column subsetting: every gold column must appear among the produced
 * columns (in any position, under any name), and the rows restricted to those columns must
 * match, as a multiset or, for ordered tasks, as a sequence. Extra columns are allowed,
 * because "top products by revenue" that also shows the category is still a right answer.
 */
export function compareResults(gold: ResultSet, produced: ResultSet, ordered: boolean): Comparison {
    if (gold.rows.length !== produced.rows.length) {
        return { pass: false, reason: `expected ${gold.rows.length} rows, got ${produced.rows.length}` };
    }
    const goldColumns = transpose(gold);
    const producedColumns = transpose(produced);
    const candidates = goldColumns.map((column) => {
        const signature = [...column].sort().join("\u0000");
        return producedColumns.map((c, i) => ([...c].sort().join("\u0000") === signature ? i : -1)).filter((i) => i >= 0);
    });
    if (candidates.some((c) => c.length === 0)) {
        const missing = candidates.findIndex((c) => c.length === 0);
        return { pass: false, reason: `no produced column matches gold column ${gold.columns[missing] ?? missing}` };
    }

    // Columns with identical value multisets can be mapped more than one way; try them all (they're few).
    const mapping: number[] = [];
    const used = new Set<number>();
    const goldRows = gold.rows.map((row) => row.map(normalize));
    const producedRows = produced.rows.map((row) => row.map(normalize));
    const rowsMatch = (): boolean => {
        const projected = producedRows.map((row) => mapping.map((i) => row[i]!).join("\u0001"));
        const expected = goldRows.map((row) => row.join("\u0001"));
        if (ordered) return projected.every((row, i) => row === expected[i]);
        return [...projected].sort().join("\u0002") === [...expected].sort().join("\u0002");
    };
    const search = (column: number): boolean => {
        if (column === candidates.length) return rowsMatch();
        for (const option of candidates[column]!) {
            if (used.has(option)) continue;
            used.add(option);
            mapping.push(option);
            if (search(column + 1)) return true;
            mapping.pop();
            used.delete(option);
        }
        return false;
    };
    if (search(0)) return { pass: true, reason: "results match" };
    return { pass: false, reason: ordered ? "same values, but rows differ or are in a different order" : "same columns, but rows differ" };
}

function transpose(result: ResultSet): string[][] {
    const width = Math.max(result.columns.length, ...result.rows.map((r) => r.length));
    return Array.from({ length: width }, (_, i) => result.rows.map((row) => normalize(row[i] ?? null)));
}
