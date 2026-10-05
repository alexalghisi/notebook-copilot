import { useCallback, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { cellId, cellSource, cellType, deleteCell, type CellMap } from "../../shared/notebook.ts";
import { runCell } from "../api.ts";
import { useOutput } from "../collab.ts";
import { CellEditor } from "./CellEditor.tsx";
import { ResultView } from "./ResultView.tsx";

interface Props {
    notebookId: string;
    doc: Y.Doc;
    cell: CellMap;
    awareness: Awareness;
    onFix: (cellId: string) => void;
    onEdit: (cellId: string) => void;
}

export function Cell({ notebookId, doc, cell, awareness, onFix, onEdit }: Props) {
    const id = cellId(cell);
    const type = cellType(cell);
    const output = useOutput(doc, id);
    const [runError, setRunError] = useState<string | null>(null);

    const run = useCallback(() => {
        if (type !== "sql") return;
        setRunError(null);
        runCell(notebookId, id).catch((error: unknown) => setRunError((error as Error).message));
    }, [notebookId, id, type]);

    return (
        <section className={`cell cell-${type}`} data-cell-id={id} data-testid="cell">
            <header className="cell-header">
                <span className="cell-type">{type === "sql" ? "SQL" : "Markdown"}</span>
                <span className="cell-id">{id}</span>
                <span className="spacer" />
                {type === "sql" && (
                    <>
                        <button
                            className="ghost"
                            onClick={() => (output?.status === "failed" ? onFix(id) : onEdit(id))}
                            title="Ask the copilot to fix or write this cell"
                        >
                            {output?.status === "failed" ? "Fix with copilot" : "Edit with copilot"}
                        </button>
                        <button onClick={run} disabled={output?.status === "running"} title="Run (Ctrl/Cmd+Enter)" data-testid="run-cell">
                            Run
                        </button>
                    </>
                )}
                <button className="ghost icon" onClick={() => deleteCell(doc, id)} title="Delete cell" aria-label="Delete cell">
                    ×
                </button>
            </header>
            <CellEditor text={cellSource(cell)} awareness={awareness} type={type} onRun={run} />
            {runError && <div className="output error">{runError}</div>}
            {type === "sql" && <ResultView output={output} />}
        </section>
    );
}
