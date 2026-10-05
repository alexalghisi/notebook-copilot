import { markdown } from "@codemirror/lang-markdown";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { CellType } from "../../shared/notebook.ts";

interface Props {
    text: Y.Text;
    awareness: Awareness;
    type: CellType;
    onRun: () => void;
}

/** A CodeMirror 6 editor bound to the cell's Y.Text, with remote cursors and per-user undo. */
export function CellEditor({ text, awareness, type, onRun }: Props) {
    const parent = useRef<HTMLDivElement>(null);
    const onRunRef = useRef(onRun);
    useEffect(() => {
        onRunRef.current = onRun;
    }, [onRun]);

    useEffect(() => {
        if (!parent.current) return;
        // Undo only reverts this user's own edits, never a collaborator's.
        const undoManager = new Y.UndoManager(text);
        const view = new EditorView({
            parent: parent.current,
            state: EditorState.create({
                doc: text.toString(),
                extensions: [
                    Prec.highest(
                        keymap.of([
                            {
                                key: "Mod-Enter",
                                run: () => {
                                    onRunRef.current();
                                    return true;
                                },
                            },
                        ]),
                    ),
                    keymap.of(yUndoManagerKeymap),
                    basicSetup,
                    type === "sql" ? sql({ dialect: PostgreSQL, upperCaseKeywords: false }) : markdown(),
                    EditorView.lineWrapping,
                    yCollab(text, awareness, { undoManager }),
                ],
            }),
        });
        return () => {
            view.destroy();
            undoManager.destroy();
        };
    }, [text, awareness, type]);

    return <div className="editor" ref={parent} data-testid="cell-editor" />;
}
