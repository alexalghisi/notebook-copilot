import { useEffect, useState } from "react";
import { createNotebook, listNotebooks, type NotebookSummary } from "../api.ts";

export function NotebookList({ onOpen }: { onOpen: (id: string) => void }) {
    const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        listNotebooks().then(setNotebooks, (e: unknown) => setError((e as Error).message));
    }, []);

    const create = async (fromTemplate: boolean) => {
        try {
            const nb = await createNotebook(fromTemplate ? "Shop analysis" : "Untitled notebook", fromTemplate);
            onOpen(nb.id);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    return (
        <main className="list">
            <h1>Notebooks</h1>
            <div className="actions">
                <button onClick={() => void create(true)}>New from the shop analysis template</button>
                <button className="ghost" onClick={() => void create(false)}>
                    New empty notebook
                </button>
            </div>
            {error && <div className="output error">{error}</div>}
            {notebooks === null && !error && <p className="muted">Loading...</p>}
            <ul>
                {notebooks?.map((nb) => (
                    <li key={nb.id}>
                        <a
                            href={`?nb=${nb.id}`}
                            onClick={(e) => {
                                e.preventDefault();
                                onOpen(nb.id);
                            }}
                        >
                            {nb.title}
                        </a>
                        <span className="muted"> {new Date(nb.createdAt).toLocaleString()}</span>
                    </li>
                ))}
            </ul>
        </main>
    );
}
