import type { TableSchema } from "../../src/server/exec/schema.ts";
import type { CellSnapshot, NotebookSnapshot } from "../../src/shared/notebook.ts";

const col = (name: string, type: string, nullable = false) => ({ name, type, nullable, comment: null });

export const TABLES: TableSchema[] = [
    { name: "customers", comment: "People who signed up", rowEstimate: 200, columns: [col("id", "integer"), col("name", "text"), col("email", "text"), col("country", "text"), col("signup_date", "date")] },
    { name: "order_items", comment: null, rowEstimate: 4000, columns: [col("order_id", "integer"), col("product_id", "integer"), col("quantity", "integer"), col("unit_price", "numeric")] },
    { name: "orders", comment: "One row per checkout", rowEstimate: 2000, columns: [col("id", "integer"), col("customer_id", "integer"), col("ordered_at", "timestamp with time zone"), col("status", "text")] },
    { name: "products", comment: null, rowEstimate: 20, columns: [col("id", "integer"), col("name", "text"), col("category", "text"), col("price", "numeric")] },
];

export function cell(id: string, source: string, extra: Partial<CellSnapshot> = {}): CellSnapshot {
    return { id, type: "sql", source, output: null, ...extra };
}

export function failed(id: string, source: string, error: string): CellSnapshot {
    return cell(id, source, { output: { runId: `run-${id}`, status: "failed", rowCount: null, error, durationMs: 3, finishedAt: null } });
}

export function notebook(cells: CellSnapshot[], title = "Shop"): NotebookSnapshot {
    return { title, cells };
}
