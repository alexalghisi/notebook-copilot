import { diffChars, diffLines } from "diff";
import * as Y from "yjs";

/** A copilot's suggested replacement for one cell, reviewed by the user before it's applied. */
export interface Proposal {
    cellId: string;
    /** The cell source the copilot saw. */
    base: string;
    proposed: string;
    explanation: string;
}

export interface DiffLine {
    kind: "same" | "add" | "del";
    text: string;
}

export function lineDiff(base: string, proposed: string): DiffLine[] {
    const lines: DiffLine[] = [];
    // A trailing newline on both sides keeps "last line without newline" from showing as changed.
    for (const part of diffLines(`${base}\n`, `${proposed}\n`)) {
        const kind = part.added ? "add" : part.removed ? "del" : "same";
        const text = part.value.endsWith("\n") ? part.value.slice(0, -1) : part.value;
        for (const line of text.split("\n")) lines.push({ kind, text: line });
    }
    return lines;
}

export interface AnchoredEdit {
    from: Y.RelativePosition;
    to: Y.RelativePosition;
    insert: string;
}

/**
 * Turns a proposal into edits anchored to the CRDT, while the cell still reads `base`.
 *
 * Positions are Yjs relative positions, which follow the characters they point at. If a
 * collaborator types elsewhere in the cell between the proposal arriving and the user
 * accepting it, the edits still land on the right text and the collaborator's typing
 * survives. Returns null when the cell already differs from what the copilot saw.
 */
export function anchorProposal(text: Y.Text, base: string, proposed: string): AnchoredEdit[] | null {
    if (text.toString() !== base) return null;
    const edits: AnchoredEdit[] = [];
    let offset = 0;
    let pending: { start: number; end: number; insert: string } | null = null;
    const flush = () => {
        if (!pending) return;
        edits.push({
            from: Y.createRelativePositionFromTypeIndex(text, pending.start),
            // assoc -1: the end sticks to the last replaced character, so typing right after it stays outside the range.
            to: Y.createRelativePositionFromTypeIndex(text, pending.end, -1),
            insert: pending.insert,
        });
        pending = null;
    };
    for (const part of diffChars(base, proposed)) {
        if (!part.added && !part.removed) {
            flush();
            offset += part.value.length;
            continue;
        }
        pending ??= { start: offset, end: offset, insert: "" };
        if (part.removed) {
            pending.end += part.value.length;
            offset += part.value.length;
        } else {
            pending.insert += part.value;
        }
    }
    flush();
    return edits;
}

/** Applies anchored edits in one transaction, so collaborators receive a single update. */
export function applyAnchored(text: Y.Text, edits: readonly AnchoredEdit[], origin: unknown = "copilot"): void {
    const doc = text.doc;
    if (!doc) throw new Error("text is not attached to a document");
    const resolved = edits
        .map((edit) => {
            const from = Y.createAbsolutePositionFromRelativePosition(edit.from, doc)?.index;
            const to = Y.createAbsolutePositionFromRelativePosition(edit.to, doc)?.index;
            return from === undefined || to === undefined ? null : { from, to: Math.max(from, to), insert: edit.insert };
        })
        .filter((edit): edit is { from: number; to: number; insert: string } => edit !== null)
        .sort((a, b) => b.from - a.from);
    doc.transact(() => {
        for (const edit of resolved) {
            if (edit.to > edit.from) text.delete(edit.from, edit.to - edit.from);
            if (edit.insert) text.insert(edit.from, edit.insert);
        }
    }, origin);
}

/** Replaces the whole cell; used when the user accepts a proposal for a cell that changed since. */
export function replaceText(text: Y.Text, value: string, origin: unknown = "copilot"): void {
    const doc = text.doc;
    const apply = () => {
        text.delete(0, text.length);
        text.insert(0, value);
    };
    if (doc) doc.transact(apply, origin);
    else apply();
}
