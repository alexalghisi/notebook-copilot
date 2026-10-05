import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/server/app.ts";
import { createPool } from "../../src/server/db/pool.ts";
import { subscribe } from "../../src/shared/graphqlStream.ts";
import { cellSource, findCell, readNotebook } from "../../src/shared/notebook.ts";
import { anchorProposal, applyAnchored } from "../../src/shared/proposal.ts";
import { startApp } from "../helpers/apps.ts";
import { connectClient } from "../helpers/collabClient.ts";
import { APP_URL } from "../helpers/env.ts";
import { gql } from "../helpers/gql.ts";
import { waitFor } from "../helpers/waitFor.ts";

let a: App & { url: string };
let b: App & { url: string };
beforeAll(async () => {
    a = await startApp();
    b = await startApp();
});
afterAll(async () => {
    await a.close();
    await b.close();
});

const COPILOT = `subscription($input: CopilotInput!) {
    copilot(input: $input) {
        kind requestId model step text toolName toolArguments toolSummary isError contextTokens contextBudget
        contextItems { kind id status }
        proposal { cellId base proposed explanation diff { kind text } }
        usage { promptTokens completionTokens costUsd estimated }
        stopReason answer error latencyMs
    }
}`;

interface Event {
    kind: string;
    requestId: string;
    text: string | null;
    toolName: string | null;
    toolArguments: string | null;
    contextTokens: number | null;
    contextBudget: number | null;
    proposal: { cellId: string; base: string; proposed: string; explanation: string; diff: Array<{ kind: string; text: string }> } | null;
    usage: { promptTokens: number; completionTokens: number } | null;
    stopReason: string | null;
    answer: string | null;
}

async function collect(url: string, input: Record<string, unknown>): Promise<Event[]> {
    const events: Event[] = [];
    for await (const data of subscribe<{ copilot: Event }>(`${url}/graphql`, COPILOT, { input })) events.push(data.copilot);
    return events;
}

async function templateNotebook(): Promise<{ id: string; cells: Array<{ id: string }> }> {
    const res = await gql<{ createNotebook: { id: string; cells: Array<{ id: string }> } }>(
        a.url,
        `mutation { createNotebook(title: "Copilot", fromTemplate: true) { id cells { id } } }`,
    );
    return res.data!.createNotebook;
}

describe("copilot over GraphQL", () => {
    it("fixes the broken cell, streaming steps, and the accepted edit reaches a collaborator on another server", async () => {
        const nb = await templateNotebook();
        const broken = nb.cells[3]!.id;
        await gql(a.url, `mutation($nb: ID!, $c: ID!) { runCell(notebookId: $nb, cellId: $c) { status } }`, { nb: nb.id, c: broken });

        const events = await collect(a.url, { notebookId: nb.id, action: "edit", prompt: "", cellId: broken });
        const kinds = events.map((e) => e.kind);
        expect(kinds[0]).toBe("started");
        expect(kinds[1]).toBe("context");
        expect(kinds.at(-1)).toBe("done");
        expect(events.filter((e) => e.kind === "tool_call").map((e) => e.toolName)).toEqual(["inspect_schema", "run_query", "propose_edit"]);
        expect(events.filter((e) => e.kind === "text").length).toBeGreaterThan(3);
        expect(new Set(events.map((e) => e.requestId)).size).toBe(1);

        const context = events[1]!;
        expect(context.contextTokens).toBeLessThanOrEqual(context.contextBudget!);
        const done = events.at(-1)!;
        expect(done.stopReason).toBe("proposal");
        expect(done.usage!.promptTokens).toBeGreaterThan(context.contextTokens!);
        const proposal = done.proposal!;
        expect(proposal.cellId).toBe(broken);
        expect(proposal.proposed).toContain("o.ordered_at");
        expect(proposal.diff.some((l) => l.kind === "add" && l.text.includes("ordered_at"))).toBe(true);

        // A user on server A accepts; a collaborator on server B sees the fix.
        const alice = connectClient(a.url, nb.id, "alice");
        const bob = connectClient(b.url, nb.id, "bob");
        try {
            await Promise.all([alice.synced(), bob.synced()]);
            const text = cellSource(findCell(alice.doc, broken)!);
            applyAnchored(text, anchorProposal(text, proposal.base, proposal.proposed)!);
            await waitFor(() => readNotebook(bob.doc).cells[3]!.source === proposal.proposed, { message: "bob to see the fix" });
        } finally {
            alice.destroy();
            bob.destroy();
        }

        const run = await gql<{ runCell: { status: string } }>(a.url, `mutation($nb: ID!, $c: ID!) { runCell(notebookId: $nb, cellId: $c) { status } }`, {
            nb: nb.id,
            c: broken,
        });
        expect(run.data!.runCell.status).toBe("succeeded");

        const history = await gql<{ copilotRequests: Array<{ status: string; stopReason: string; steps: number; latencyMs: number; promptTokens: number }> }>(
            a.url,
            `query($nb: ID!) { copilotRequests(notebookId: $nb) { status stopReason steps latencyMs promptTokens } }`,
            { nb: nb.id },
        );
        expect(history.data!.copilotRequests[0]).toMatchObject({ status: "done", stopReason: "proposal", steps: 3 });
    });

    it("answers a data question by running a query", async () => {
        const nb = await templateNotebook();
        const events = await collect(a.url, { notebookId: nb.id, action: "ask", prompt: "how many orders were refunded?" });
        const done = events.at(-1)!;
        expect(done.stopReason).toBe("answer");
        expect(done.answer).toMatch(/The answer is \d+\./);
        expect(events.find((e) => e.kind === "tool_call")?.toolArguments).toContain("o.status = 'refunded'");
    });

    it("rejects invalid input before running anything", async () => {
        const nb = await templateNotebook();
        await expect(collect(a.url, { notebookId: nb.id, action: "edit", prompt: "x" })).rejects.toThrow(/needs a cellId/);
        await expect(collect(a.url, { notebookId: nb.id, action: "edit", prompt: "x", cellId: "nope" })).rejects.toThrow(/not found/);
        await expect(collect(a.url, { notebookId: "bad", action: "ask", prompt: "x" })).rejects.toThrow(/UUID/);
        const pool = createPool(APP_URL, 1);
        try {
            const { rows } = await pool.query(`SELECT 1 FROM copilot_requests WHERE notebook_id = $1`, [nb.id]);
            expect(rows).toHaveLength(0);
        } finally {
            await pool.end();
        }
    });
});
