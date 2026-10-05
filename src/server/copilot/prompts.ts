export type CopilotAction = "ask" | "edit";

export const SYSTEM_PROMPT = `You are the assistant inside a collaborative SQL notebook. Cells run on PostgreSQL 16 against a small shop database (customers, products, orders, order_items).

Tools:
- inspect_schema: table columns and comments.
- run_query: run one read-only statement and see the first rows or the error. Use it to check a query before you propose it.
- read_cell_output: the latest result or error of a cell.
- propose_edit: suggest the complete new source of a cell. The user sees a diff and decides.

Rules:
- Use only tables and columns that exist. When unsure, inspect the schema.
- When asked to fix or write a cell, finish by calling propose_edit once with SQL you have run successfully.
- Revenue counts only orders with status 'paid' or 'shipped' and is quantity * unit_price from order_items.
- Answer in a few sentences. Refer to cells by id. Don't repeat the whole notebook back.`;

export function userMessage(action: CopilotAction, prompt: string, focusCellId: string | null, context: string): string {
    const task =
        action === "edit" && focusCellId
            ? `Task: edit cell ${focusCellId}. ${prompt.trim() || "Fix the error in this cell."}`
            : `Question: ${prompt.trim()}`;
    return `${context}\n\n${task}`;
}
