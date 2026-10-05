import { useEffect, useState } from "react";
import { currentUser } from "./collab.ts";
import { Notebook } from "./components/Notebook.tsx";
import { NotebookList } from "./components/NotebookList.tsx";

function notebookFromUrl(): string | null {
    return new URLSearchParams(location.search).get("nb");
}

export function App() {
    const [user] = useState(currentUser);
    const [notebookId, setNotebookId] = useState(notebookFromUrl);

    useEffect(() => {
        const onPop = () => setNotebookId(notebookFromUrl());
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    const open = (id: string) => {
        const params = new URLSearchParams(location.search);
        params.set("nb", id);
        history.pushState(null, "", `?${params.toString()}`);
        setNotebookId(id);
    };

    return notebookId ? <Notebook key={notebookId} notebookId={notebookId} user={user} /> : <NotebookList onOpen={open} />;
}
