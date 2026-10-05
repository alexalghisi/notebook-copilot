import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { anchorProposal, applyAnchored, lineDiff, replaceText } from "../../src/shared/proposal.ts";

function textOf(value: string): Y.Text {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, value);
    return text;
}

function sync(a: Y.Doc, b: Y.Doc): void {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

const BASE = "select date_trunc('month', o.orderd_at), count(*)\nfrom orders o\ngroup by 1";
const FIXED = "select date_trunc('month', o.ordered_at), count(*)\nfrom orders o\ngroup by 1\norder by 1";

describe("proposals", () => {
    it("produces a line diff for review", () => {
        expect(lineDiff(BASE, FIXED)).toEqual([
            { kind: "del", text: "select date_trunc('month', o.orderd_at), count(*)" },
            { kind: "add", text: "select date_trunc('month', o.ordered_at), count(*)" },
            { kind: "same", text: "from orders o" },
            { kind: "same", text: "group by 1" },
            { kind: "add", text: "order by 1" },
        ]);
    });

    it("applies to an unchanged cell and yields exactly the proposed text", () => {
        const text = textOf(BASE);
        applyAnchored(text, anchorProposal(text, BASE, FIXED)!);
        expect(text.toString()).toBe(FIXED);
    });

    it("keeps a collaborator's concurrent edit elsewhere in the cell", () => {
        const text = textOf(BASE);
        const edits = anchorProposal(text, BASE, FIXED)!;
        // Someone adds a comment at the top and a filter in the middle before the user accepts.
        text.insert(0, "-- by month\n");
        const fromIndex = text.toString().indexOf("from orders o") + "from orders o".length;
        text.insert(fromIndex, "\nwhere o.status = 'paid'");
        applyAnchored(text, edits);
        expect(text.toString()).toBe("-- by month\nselect date_trunc('month', o.ordered_at), count(*)\nfrom orders o\nwhere o.status = 'paid'\ngroup by 1\norder by 1");
    });

    it("converges when one replica accepts while another keeps typing", () => {
        const a = new Y.Doc();
        a.getText("t").insert(0, BASE);
        const b = new Y.Doc();
        sync(a, b);
        const edits = anchorProposal(a.getText("t"), BASE, FIXED)!;
        b.getText("t").insert(b.getText("t").length, " -- done");
        applyAnchored(a.getText("t"), edits);
        sync(a, b);
        expect(a.getText("t").toString()).toBe(b.getText("t").toString());
        expect(a.getText("t").toString()).toContain("o.ordered_at");
        expect(a.getText("t").toString()).toContain("-- done");
    });

    it("refuses to anchor once the cell differs from what the copilot saw", () => {
        const text = textOf(`${BASE} limit 5`);
        expect(anchorProposal(text, BASE, FIXED)).toBeNull();
        replaceText(text, FIXED);
        expect(text.toString()).toBe(FIXED);
    });

    it("handles full rewrites and empty cells", () => {
        const empty = textOf("");
        applyAnchored(empty, anchorProposal(empty, "", "select 1")!);
        expect(empty.toString()).toBe("select 1");
        const full = textOf("abc");
        applyAnchored(full, anchorProposal(full, "abc", "")!);
        expect(full.toString()).toBe("");
    });
});
