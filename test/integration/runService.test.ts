import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/server/app.ts";
import { RunService } from "../../src/server/exec/runService.ts";
import type { QueryResult, QueryRunner } from "../../src/server/exec/sqlRunner.ts";
import { createPool } from "../../src/server/db/pool.ts";
import { outputsOf, readNotebook } from "../../src/shared/notebook.ts";
import { startApp } from "../helpers/apps.ts";
import { connectClient, type CollabClient } from "../helpers/collabClient.ts";
import { APP_URL } from "../helpers/env.ts";
import { waitFor } from "../helpers/waitFor.ts";

const apps: App[] = [];
const clients: CollabClient[] = [];
afterEach(async () => {
    clients.splice(0).forEach((c) => c.destroy());
    await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(cells: Array<{ type: "sql" | "markdown"; source: string }>) {
    const a = await startApp();
    const b = await startApp();
    apps.push(a, b);
    const nb = await a.notebooks.create("runs", cells);
    const bob = connectClient(b.url, nb.id, "bob");
    clients.push(bob);
    await bob.synced();
    return { a, b, nb, bob, cellIds: readNotebook(bob.doc).cells.map((c) => c.id) };
}

describe("RunService", () => {
    it("stores results and shows the run summary to collaborators on other servers", async () => {
        const { a, nb, bob, cellIds } = await setup([{ type: "sql", source: "select country, count(*) from customers group by 1 order by 1" }]);
        const run = await a.runs.runCell(nb.id, cellIds[0]!);

        expect(run.status).toBe("succeeded");
        expect(run.columns.map((c) => c.name)).toEqual(["country", "count"]);
        expect(run.rows.length).toBe(8);
        await waitFor(() => outputsOf(bob.doc).get(cellIds[0]!)?.runId === run.id && outputsOf(bob.doc).get(cellIds[0]!)?.status === "succeeded");
        expect(outputsOf(bob.doc).get(cellIds[0]!)?.rowCount).toBe(8);
        expect((await a.runs.latestForCell(nb.id, cellIds[0]!))?.id).toBe(run.id);
    });

    it("records failures with the database's message and position", async () => {
        const { a, nb, bob, cellIds } = await setup([{ type: "sql", source: "select nmae from customers" }]);
        const run = await a.runs.runCell(nb.id, cellIds[0]!);
        expect(run.status).toBe("failed");
        expect(run.error).toMatch(/column "nmae" does not exist/);
        expect(run.errorPosition).toBe(8);
        await waitFor(() => outputsOf(bob.doc).get(cellIds[0]!)?.status === "failed");
    });

    it("refuses markdown cells and unknown cells", async () => {
        const { a, nb, cellIds } = await setup([{ type: "markdown", source: "# hi" }]);
        await expect(a.runs.runCell(nb.id, cellIds[0]!)).rejects.toThrow(/only SQL cells/);
        await expect(a.runs.runCell(nb.id, "nope")).rejects.toThrow(/not found/);
    });

    it("keeps the newest run's output when an older run finishes last", async () => {
        const { a, nb, bob, cellIds } = await setup([{ type: "sql", source: "select 1" }]);
        const pool = createPool(APP_URL, 2);
        const release: Array<() => void> = [];
        const result: QueryResult = { columns: [{ name: "x", type: "int4" }], rows: [[1]], rowCount: 1, truncated: false, durationMs: 1 };
        const slowRunner: QueryRunner = { run: () => new Promise((resolve) => release.push(() => resolve(result))) };
        const service = new RunService(pool, a.rooms, slowRunner);
        try {
            const first = service.runCell(nb.id, cellIds[0]!);
            await waitFor(() => release.length === 1);
            const second = service.runCell(nb.id, cellIds[0]!);
            await waitFor(() => release.length === 2);
            release[1]!();
            const newer = await second;
            release[0]!();
            await first;
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(outputsOf(bob.doc).get(cellIds[0]!)?.runId).toBe(newer.id);
        } finally {
            await pool.end();
        }
    });
});
