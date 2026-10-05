/**
 * Just enough SQL lexing for context selection and the offline model: which tables a
 * statement reads, what their aliases are, and which identifiers it mentions. It is not a
 * parser and doesn't need to be; a wrong guess costs a few tokens of context, not a wrong
 * result, because every query is checked by actually running it.
 */
export interface SqlToken {
    kind: "word" | "quoted" | "string" | "number" | "symbol";
    text: string;
    /** 0-based offset into the source. */
    start: number;
}

export function lexSql(sql: string): SqlToken[] {
    const tokens: SqlToken[] = [];
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i]!;
        if (/\s/.test(ch)) {
            i++;
        } else if (sql.startsWith("--", i)) {
            const end = sql.indexOf("\n", i);
            i = end < 0 ? sql.length : end;
        } else if (sql.startsWith("/*", i)) {
            const end = sql.indexOf("*/", i + 2);
            i = end < 0 ? sql.length : end + 2;
        } else if (ch === "'") {
            let j = i + 1;
            while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
            tokens.push({ kind: "string", text: sql.slice(i, j + 1), start: i });
            i = j + 1;
        } else if (ch === '"') {
            const end = sql.indexOf('"', i + 1);
            const j = end < 0 ? sql.length : end;
            tokens.push({ kind: "quoted", text: sql.slice(i + 1, j), start: i });
            i = j + 1;
        } else if (/[A-Za-z_]/.test(ch)) {
            let j = i + 1;
            while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
            tokens.push({ kind: "word", text: sql.slice(i, j), start: i });
            i = j;
        } else if (/[0-9]/.test(ch)) {
            let j = i + 1;
            while (j < sql.length && /[0-9.]/.test(sql[j]!)) j++;
            tokens.push({ kind: "number", text: sql.slice(i, j), start: i });
            i = j;
        } else {
            tokens.push({ kind: "symbol", text: ch, start: i });
            i++;
        }
    }
    return tokens;
}

const CLAUSE_END = new Set([
    "where", "group", "order", "having", "limit", "offset", "on", "using", "join", "inner", "left", "right", "full",
    "cross", "natural", "union", "except", "intersect", "window", "fetch", "for", "lateral", "as",
]);

export interface TableRef {
    table: string;
    alias: string | null;
}

/** Tables in FROM / JOIN clauses (including comma-separated lists) with their aliases. */
export function tableRefs(sql: string): TableRef[] {
    const tokens = lexSql(sql);
    const refs: TableRef[] = [];
    const isName = (t: SqlToken | undefined): t is SqlToken => t !== undefined && (t.kind === "word" || t.kind === "quoted");
    for (let i = 0; i < tokens.length; i++) {
        const word = tokens[i]!.kind === "word" ? tokens[i]!.text.toLowerCase() : "";
        if (word !== "from" && word !== "join") continue;
        let j = i + 1;
        for (;;) {
            if (tokens[j]?.text === "(") break; // subquery: its own FROM is visited by the outer loop
            if (!isName(tokens[j])) break;
            let name = tokens[j]!.text;
            // schema.table
            if (tokens[j + 1]?.text === "." && isName(tokens[j + 2])) {
                name = tokens[j + 2]!.text;
                j += 2;
            }
            j++;
            let alias: string | null = null;
            if (tokens[j]?.kind === "word" && tokens[j]!.text.toLowerCase() === "as") j++;
            const next = tokens[j];
            if (isName(next) && !CLAUSE_END.has(next.text.toLowerCase())) {
                alias = next.text;
                j++;
            }
            refs.push({ table: name.toLowerCase(), alias: alias?.toLowerCase() ?? null });
            if (word === "join" || tokens[j]?.text !== ",") break;
            j++;
        }
    }
    return refs;
}

export function aliasMap(sql: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const ref of tableRefs(sql)) {
        map.set(ref.table, ref.table);
        if (ref.alias) map.set(ref.alias, ref.table);
    }
    return map;
}

/** Lower-cased identifier-like words of any text: SQL, markdown or a question. */
export function wordsOf(text: string): Set<string> {
    const words = new Set<string>();
    for (const match of text.toLowerCase().matchAll(/[a-z_][a-z0-9_]*/g)) {
        if (match[0].length > 1 && !STOP_WORDS.has(match[0])) words.add(match[0]);
    }
    return words;
}

/** Table names a piece of prose mentions, including singular forms ("customer" -> customers). */
export function tablesMentioned(text: string, tables: readonly string[]): string[] {
    const words = wordsOf(text);
    return tables.filter((table) => {
        const singular = table.endsWith("ies") ? `${table.slice(0, -3)}y` : table.replace(/s$/, "");
        return words.has(table) || words.has(singular) || words.has(table.replace(/_/g, ""));
    });
}

export function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost));
        }
        previous = current;
    }
    return previous[b.length]!;
}

/** The closest candidate within a distance that still looks like a typo, or null. */
export function closest(word: string, candidates: Iterable<string>): string | null {
    const target = word.toLowerCase();
    const limit = target.length <= 4 ? 1 : target.length <= 8 ? 2 : 3;
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        const distance = levenshtein(target, candidate.toLowerCase());
        if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best !== null && bestDistance > 0 && bestDistance <= limit ? best : null;
}

const STOP_WORDS = new Set([
    "select", "from", "where", "and", "or", "not", "as", "by", "on", "in", "is", "null", "the", "of", "to", "for", "with",
    "group", "order", "limit", "join", "left", "right", "inner", "outer", "desc", "asc", "count", "sum", "avg", "min", "max",
    "case", "when", "then", "else", "end", "distinct", "having", "this", "that", "what", "which", "how", "are", "was", "it",
    "be", "an", "do", "does", "per", "each", "me", "my", "can", "you", "show", "all",
]);
