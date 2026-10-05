import { useEffect, useState } from "react";
import { insertCell, type CellType } from "../../shared/notebook.ts";
import { fetchModel } from "../api.ts";
import { useCells, useCollab, usePeers, useStatus, useTitle, type Collab, type User } from "../collab.ts";
import { Cell } from "./Cell.tsx";
import { useCopilot } from "../useCopilot.ts";
import { CopilotPanel } from "./CopilotPanel.tsx";

export function Notebook({ notebookId, user }: { notebookId: string; user: User }) {
    const collab = useCollab(notebookId, user);
    if (!collab) return <main className="muted center">Connecting...</main>;
    return <NotebookView notebookId={notebookId} collab={collab} />;
}

function NotebookView({ notebookId, collab }: { notebookId: string; collab: Collab }) {
    const { doc, provider } = collab;
    const { status, synced } = useStatus(provider);
    const cells = useCells(doc);
    const title = useTitle(doc);
    const peers = usePeers(provider);
    const copilot = useCopilot(notebookId, doc);
    // A cell picked for "Edit with copilot": the panel then asks what the cell should do.
    const [editTarget, setEditTarget] = useState<string | null>(null);
    const [model, setModel] = useState<string | null>(null);

    useEffect(() => {
        fetchModel().then(setModel, () => setModel(null));
    }, []);
    useEffect(() => {
        document.title = `${title} · Notebook`;
    }, [title]);

    const add = (type: CellType) => insertCell(doc, cells.length, type, type === "sql" ? "select " : "");

    return (
        <div className="layout">
            <main className="notebook">
                <header className="notebook-header">
                    <a href="?" className="back" title="All notebooks">
                        ←
                    </a>
                    <h1>{title}</h1>
                    <span className="spacer" />
                    <ul className="peers" aria-label="People in this notebook" data-testid="peers">
                        {peers.map((peer) => (
                            <li key={peer.clientId} style={{ background: peer.user.color }} title={peer.isSelf ? `${peer.user.name} (you)` : peer.user.name}>
                                {peer.isSelf ? `${peer.user.name} (you)` : peer.user.name}
                            </li>
                        ))}
                    </ul>
                    <button
                        className={`status status-${status}`}
                        data-testid="connection-status"
                        title={provider.shouldConnect ? "Click to work offline" : "Click to reconnect"}
                        onClick={() => (provider.shouldConnect ? provider.disconnect() : provider.connect())}
                    >
                        {!provider.shouldConnect
                            ? "Offline, edits are kept"
                            : status === "connected"
                              ? synced
                                  ? "Live"
                                  : "Syncing"
                              : status === "connecting"
                                ? "Connecting"
                                : "Reconnecting"}
                    </button>
                </header>
                {cells.map((cell) => (
                    <Cell
                        key={cell.get("id") as string}
                        notebookId={notebookId}
                        doc={doc}
                        cell={cell}
                        awareness={provider.awareness}
                        onFix={(cellId) => {
                            setEditTarget(null);
                            copilot.start({ action: "edit", prompt: "", cellId });
                        }}
                        onEdit={setEditTarget}
                    />
                ))}
                {synced && (
                    <div className="add-cell">
                        <button className="ghost" onClick={() => add("sql")}>
                            + SQL
                        </button>
                        <button className="ghost" onClick={() => add("markdown")}>
                            + Markdown
                        </button>
                    </div>
                )}
            </main>
            <CopilotPanel copilot={copilot} model={model} editTarget={editTarget} onClearTarget={() => setEditTarget(null)} />
        </div>
    );
}
