import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/server/app.ts";
import { outputsOf } from "../../src/shared/notebook.ts";
import { startApp } from "../helpers/apps.ts";
import { connectClient } from "../helpers/collabClient.ts";
import { gql } from "../helpers/gql.ts";
import { waitFor } from "../helpers/waitFor.ts";

let app: App & { url: string };
beforeAll(async () => {
    app = await startApp();
});
afterAll(() => app.close());

interface CellData {
    id: string;
    type: string;
    source: string;
    output: { status: string; runId: string } | null;
}

async function createTemplateNotebook(): Promise<{ id: string; cells: CellData[] }> {
    const res = await gql<{ createNotebook: { id: string; cells: CellData[] } }>(
        app.url,
        `mutation { createNotebook(title: "Shop", fromTemplate: true) { id cells { id type source output { status runId } } } }`,
    );
    expect(res.errors).toBeUndefined();
    return res.data!.createNotebook;
}

describe("GraphQL API", () => {
    it("creates a notebook from the template and reads its live cells", async () => {
        const nb = await createTemplateNotebook();
        expect(nb.cells.map((c) => c.type)).toEqual(["markdown", "sql", "sql", "sql"]);

        const list = await gql<{ notebooks: Array<{ id: string; title: string }> }>(app.url, `{ notebooks { id title } }`);
        expect(list.data!.notebooks.some((n) => n.id === nb.id && n.title === "Shop")).toBe(true);
    });

    it("runs a cell, returns rows and reflects the output in the document and in later queries", async () => {
        const nb = await createTemplateNotebook();
        const client = connectClient(app.url, nb.id);
        try {
            await client.synced();
            const cell = nb.cells[1]!;
            const res = await gql<{ runCell: { id: string; status: string; columns: Array<{ name: string }>; rows: unknown[][]; truncated: boolean } }>(
                app.url,
                `mutation($nb: ID!, $cell: ID!) { runCell(notebookId: $nb, cellId: $cell) { id status columns { name } rows truncated } }`,
                { nb: nb.id, cell: cell.id },
            );
            expect(res.errors).toBeUndefined();
            const run = res.data!.runCell;
            expect(run.status).toBe("succeeded");
            expect(run.columns.map((c) => c.name)).toEqual(["country", "customers"]);
            expect(run.rows).toHaveLength(8);
            await waitFor(() => outputsOf(client.doc).get(cell.id)?.runId === run.id);

            const again = await gql<{ notebook: { cells: CellData[]; runs: Array<{ id: string }> }; run: { rows: unknown[][] } }>(
                app.url,
                `query($nb: ID!, $run: ID!) { notebook(id: $nb) { cells { id output { status runId } } runs { id } } run(id: $run) { rows } }`,
                { nb: nb.id, run: run.id },
            );
            expect(again.data!.notebook.cells[1]!.output).toEqual({ status: "succeeded", runId: run.id });
            expect(again.data!.notebook.runs.map((r) => r.id)).toEqual([run.id]);
            expect(again.data!.run.rows).toEqual(run.rows);
        } finally {
            client.destroy();
        }
    });

    it("returns the broken template cell's error instead of throwing", async () => {
        const nb = await createTemplateNotebook();
        const res = await gql<{ runCell: { status: string; error: string } }>(
            app.url,
            `mutation($nb: ID!, $cell: ID!) { runCell(notebookId: $nb, cellId: $cell) { status error } }`,
            { nb: nb.id, cell: nb.cells[3]!.id },
        );
        expect(res.data!.runCell.status).toBe("failed");
        expect(res.data!.runCell.error).toMatch(/orderd_at/);
    });

    it("reports bad input as user errors and hides internal ones", async () => {
        const bad = await gql(app.url, `mutation { runCell(notebookId: "nope", cellId: "x") { id } }`);
        expect(bad.errors?.[0]).toMatchObject({ message: "notebookId must be a UUID", extensions: { code: "BAD_USER_INPUT" } });
        const missing = await gql(app.url, `mutation { runCell(notebookId: "00000000-0000-4000-8000-000000000000", cellId: "x") { id } }`);
        expect(missing.errors?.[0]?.message).toBe("notebook not found");
        const title = await gql(app.url, `mutation { createNotebook(title: "  ") { id } }`);
        expect(title.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
        expect((await gql<{ notebook: null }>(app.url, `{ notebook(id: "x") { id } }`)).data).toEqual({ notebook: null });
    });

    it("describes the sample schema", async () => {
        const res = await gql<{ sampleSchema: Array<{ name: string; columns: Array<{ name: string }> }> }>(
            app.url,
            `{ sampleSchema { name columns { name } } }`,
        );
        expect(res.data!.sampleSchema.find((t) => t.name === "order_items")?.columns.map((c) => c.name)).toEqual([
            "order_id",
            "product_id",
            "quantity",
            "unit_price",
        ]);
    });
});
