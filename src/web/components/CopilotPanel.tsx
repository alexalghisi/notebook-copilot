import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { ProposalData } from "../api.ts";
import type { Copilot, ProposalState } from "../useCopilot.ts";

const STOP_LABELS: Record<string, string> = {
    answer: "answered",
    proposal: "proposed an edit",
    step_limit: "stopped at the step limit",
    cost_limit: "stopped at the cost limit",
    token_limit: "stopped at the token limit",
    error: "failed",
    cancelled: "cancelled",
};

interface Props {
    copilot: Copilot;
    model: string | null;
    editTarget: string | null;
    onClearTarget: () => void;
}

export function CopilotPanel({ copilot, model, editTarget, onClearTarget }: Props) {
    const { session, start, accept, reject } = copilot;
    const [question, setQuestion] = useState("");
    const [contextOpenFor, setContextOpenFor] = useState<object | null>(null);
    const showContext = session !== null && contextOpenFor === session.request;

    const ask = (e: FormEvent | KeyboardEvent) => {
        e.preventDefault();
        if (!question.trim()) return;
        start(editTarget ? { action: "edit", prompt: question.trim(), cellId: editTarget } : { action: "ask", prompt: question.trim(), cellId: null });
        setQuestion("");
        onClearTarget();
    };

    return (
        <aside className="copilot" data-testid="copilot">
            <header className="copilot-header">
                <h2>Copilot</h2>
                {model && <span className="badge" title="Set LLM_API_KEY on the server to use a hosted model">{model}</span>}
            </header>
            {editTarget && (
                <div className="target">
                    Writing cell <span className="mono">{editTarget}</span>: describe what it should compute.
                    <span className="spacer" />
                    <button className="ghost icon" onClick={onClearTarget} aria-label="Cancel">
                        ×
                    </button>
                </div>
            )}
            <form className="ask" onSubmit={ask}>
                <textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder={editTarget ? "e.g. top 5 products by revenue" : "Ask about this notebook or the data, e.g. how many orders were refunded?"}
                    data-testid="copilot-input"
                    rows={2}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) ask(e);
                    }}
                />
                <button type="submit" disabled={!question.trim()} data-testid="copilot-submit">
                    {editTarget ? "Write" : "Ask"}
                </button>
            </form>

            {!session && <p className="muted hint">Ask a question, or use "Fix with copilot" on a cell to get a proposed edit.</p>}

            {session && (
                <div className="session" data-testid="copilot-session">
                    <div className="session-task">
                        {session.request.action === "edit" ? `Edit cell ${session.request.cellId}` : session.request.prompt}
                        {session.request.action === "edit" && session.request.prompt ? `: ${session.request.prompt}` : ""}
                    </div>

                    {session.context && (
                        <div className="context">
                            <button className="link" onClick={() => setContextOpenFor(showContext ? null : session.request)}>
                                Context {session.context.tokens.toLocaleString()} / {session.context.budget.toLocaleString()} tokens,{" "}
                                {session.context.items.filter((i) => i.status !== "dropped").length} of {session.context.items.length} items
                            </button>
                            {showContext && (
                                <ul className="context-items">
                                    {session.context.items.map((item) => (
                                        <li key={`${item.kind}:${item.id}`} className={item.status}>
                                            <span className="mono">
                                                {item.kind} {item.id}
                                            </span>{" "}
                                            {item.status}, {item.tokens} tok <span className="muted">({item.reason})</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {session.tools.length > 0 && (
                        <ol className="steps">
                            {session.tools.map((tool, i) => (
                                <li key={i} className={tool.isError ? "error" : ""}>
                                    <span className="mono">{tool.name}</span>
                                    {tool.summary ? <span className="muted"> {tool.summary}</span> : <span className="muted"> ...</span>}
                                </li>
                            ))}
                        </ol>
                    )}

                    {session.text && (
                        <div className="answer" data-testid="copilot-answer">
                            {session.text}
                            {session.status === "running" && <span className="caret" />}
                        </div>
                    )}

                    {session.proposal && <ProposalView proposal={session.proposal} state={session.proposalState} onAccept={accept} onReject={reject} />}

                    {session.error && <div className="output error">{session.error}</div>}

                    {session.status !== "running" && session.usage && (
                        <footer className="usage" data-testid="copilot-usage">
                            {STOP_LABELS[session.stopReason ?? ""] ?? session.stopReason} · {session.usage.promptTokens.toLocaleString()} prompt +{" "}
                            {session.usage.completionTokens.toLocaleString()} completion tokens{session.usage.estimated ? " (counted locally)" : ""} · $
                            {session.usage.costUsd.toFixed(4)} · {session.latencyMs} ms
                            {session.firstTokenMs !== null ? `, first token ${session.firstTokenMs} ms` : ""}
                        </footer>
                    )}
                </div>
            )}
        </aside>
    );
}

function ProposalView({ proposal, state, onAccept, onReject }: { proposal: ProposalData; state: ProposalState; onAccept: (force: boolean) => void; onReject: () => void }) {
    return (
        <div className="proposal" data-testid="proposal">
            <div className="proposal-title">Proposed edit to cell {proposal.cellId}</div>
            {proposal.explanation && <p className="explanation">{proposal.explanation}</p>}
            <pre className="diff">
                {proposal.diff.map((line, i) => (
                    <div key={i} className={`diff-${line.kind}`}>
                        {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                        {line.text}
                    </div>
                ))}
            </pre>
            {state === "pending" && (
                <div className="actions">
                    <button onClick={() => onAccept(false)} data-testid="accept-proposal">
                        Accept and run
                    </button>
                    <button className="ghost" onClick={onReject}>
                        Reject
                    </button>
                </div>
            )}
            {state === "stale" && (
                <div className="actions">
                    <span className="muted">The cell changed while the copilot was working.</span>
                    <button onClick={() => onAccept(true)}>Replace anyway</button>
                    <button className="ghost" onClick={onReject}>
                        Reject
                    </button>
                </div>
            )}
            {state === "applied" && <div className="muted">Applied. Collaborators see the change.</div>}
            {state === "rejected" && <div className="muted">Rejected.</div>}
        </div>
    );
}
