import { useEffect, useState } from "react";
import type { OutputSummary } from "../../shared/notebook.ts";
import { fetchRun, type RunData } from "../api.ts";

const SHOWN_ROWS = 50;

function display(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value)) return value.slice(0, 10);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

/** Shows a cell's latest run. Rows are fetched once per run id, so every collaborator loads the same stored result. */
export function ResultView({ output }: { output: OutputSummary | undefined }) {
    const [run, setRun] = useState<RunData | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const runId = output?.status === "succeeded" ? output.runId : null;

    useEffect(() => {
        if (!runId) return;
        let cancelled = false;
        fetchRun(runId).then(
            (data) => {
                if (!cancelled) setRun(data);
            },
            (error: unknown) => {
                if (!cancelled) setLoadError((error as Error).message);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [runId]);

    if (!output) return null;
    if (output.status === "running") return <div className="output muted">Running...</div>;
    if (output.status === "failed") {
        return (
            <div className="output error" role="alert" data-testid="cell-error">
                {output.error}
            </div>
        );
    }
    if (loadError) return <div className="output error">Couldn't load the result: {loadError}</div>;
    if (!run || run.id !== runId) return <div className="output muted">Loading result...</div>;

    const rows = run.rows.slice(0, SHOWN_ROWS);
    return (
        <div className="output" data-testid="cell-result">
            <div className="output-meta">
                {run.rowCount} row{run.rowCount === 1 ? "" : "s"}
                {run.truncated ? " (limit reached)" : ""} in {run.durationMs} ms
                {run.rows.length > SHOWN_ROWS ? `, showing ${SHOWN_ROWS}` : ""}
            </div>
            <div className="table-wrap">
                <table>
                    <thead>
                        <tr>
                            {run.columns.map((c, i) => (
                                <th key={i} title={c.type}>
                                    {c.name}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, r) => (
                            <tr key={r}>
                                {row.map((value, c) => (
                                    <td key={c} className={typeof value === "number" || /^-?\d+(\.\d+)?$/.test(String(value)) ? "num" : ""}>
                                        {display(value)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
