import { aliasMap, closest, lexSql, tableRefs, type SqlToken } from "../sqlRefs.ts";

/** Table name -> column names, as the offline model learns it from inspect_schema. */
export type SchemaInfo = Map<string, string[]>;

/** Parses the `name(col type, ...) -- notes` lines that inspect_schema returns. */
export function parseSchemaText(text: string): SchemaInfo {
    const schema: SchemaInfo = new Map();
    for (const line of text.split("\n")) {
        const match = /^(\w+)\((.*?)\)(?:\s+--.*)?$/.exec(line.trim());
        if (!match) continue;
        const columns = match[2]!.split(",").map((c) => c.trim().split(/\s+/)[0]!).filter(Boolean);
        schema.set(match[1]!, columns);
    }
    return schema;
}

export interface Repair {
    sql: string;
    note: string;
}

const KEYWORDS = [
    "select", "from", "where", "group", "order", "by", "having", "limit", "join", "inner", "left", "right", "outer", "on",
    "and", "or", "not", "in", "as", "distinct", "desc", "asc", "between", "like", "is", "null", "case", "when", "then", "else", "end",
];
const FUNCTIONS = ["count", "sum", "avg", "min", "max", "round", "date_trunc", "extract", "coalesce", "lower", "upper", "length", "now"];

/**
 * Error-driven repairs: read the Postgres error, find the identifier it complains about
 * and replace it with the closest thing that exists. Each rule handles one error shape;
 * anything else returns null and the model says it couldn't fix the cell.
 */
export function repairSql(sql: string, error: string, schema: SchemaInfo): Repair | null {
    const rules = [badColumn, badRelation, missingGroupBy, missingFromEntry, ambiguousColumn, unknownFunction, syntaxError];
    for (const rule of rules) {
        const repair = rule(sql, error, schema);
        if (repair && repair.sql !== sql) return repair;
    }
    return null;
}

function badColumn(sql: string, error: string, schema: SchemaInfo): Repair | null {
    const match = /column (?:"([^"]+)"|(\S+)) does not exist/.exec(error);
    const name = match?.[1] ?? match?.[2];
    if (!name) return null;
    const [qualifier, column] = name.includes(".") ? (name.split(".") as [string, string]) : [null, name];
    const aliases = aliasMap(sql);
    const tables = qualifier ? [aliases.get(qualifier.toLowerCase()) ?? qualifier.toLowerCase()] : tableRefs(sql).map((r) => r.table);
    const candidates = tables.flatMap((t) => schema.get(t) ?? []);
    const replacement = closest(column, candidates);
    if (!replacement) return null;
    return {
        sql: replaceWords(sql, (token, prev) => token.text.toLowerCase() === column.toLowerCase() && (qualifier === null || prev?.toLowerCase() === qualifier.toLowerCase()), replacement),
        note: `\`${column}\` isn't a column${qualifier ? ` of ${tables[0]}` : ""}; the closest match is \`${replacement}\`.`,
    };
}

function badRelation(sql: string, error: string, schema: SchemaInfo): Repair | null {
    const name = /relation "([^"]+)" does not exist/.exec(error)?.[1];
    if (!name) return null;
    const replacement = closest(name, schema.keys());
    if (!replacement) return null;
    return {
        sql: replaceWords(sql, (token) => token.text.toLowerCase() === name.toLowerCase(), replacement),
        note: `There is no table \`${name}\`; the table is called \`${replacement}\`.`,
    };
}

function missingGroupBy(sql: string, error: string): Repair | null {
    const expr = /column "([^"]+)" must appear in the GROUP BY clause/.exec(error)?.[1];
    if (!expr) return null;
    const tokens = lexSql(sql);
    const groupIndex = tokens.findIndex((t, i) => t.text.toLowerCase() === "group" && tokens[i + 1]?.text.toLowerCase() === "by");
    if (groupIndex >= 0) {
        // Append to the existing GROUP BY list: insert before the clause that follows it, if any.
        const after = tokens.slice(groupIndex + 2).find((t) => ["having", "order", "limit", "window"].includes(t.text.toLowerCase()));
        const at = after ? after.start : sql.replace(/[\s;]+$/, "").length;
        const before = sql.slice(0, at).replace(/\s+$/, "");
        return { sql: `${before}, ${expr}${after ? `\n${sql.slice(at)}` : sql.slice(at)}`, note: `\`${expr}\` is selected without an aggregate, so it has to be in GROUP BY.` };
    }
    const next = tokens.find((t) => ["having", "order", "limit"].includes(t.text.toLowerCase()));
    const at = next ? next.start : sql.replace(/[\s;]+$/, "").length;
    const before = sql.slice(0, at).replace(/\s+$/, "");
    return {
        sql: `${before}\ngroup by ${expr}${next ? `\n${sql.slice(at)}` : sql.slice(at)}`,
        note: `The query mixes an aggregate with \`${expr}\`, which needs a GROUP BY.`,
    };
}

function missingFromEntry(sql: string, error: string): Repair | null {
    const name = /missing FROM-clause entry for table "([^"]+)"/.exec(error)?.[1];
    if (!name) return null;
    const replacement = closest(name, aliasMap(sql).keys());
    if (!replacement) return null;
    return {
        sql: replaceWords(sql, (token, _prev, next) => token.text.toLowerCase() === name.toLowerCase() && next === ".", replacement),
        note: `\`${name}\` isn't an alias in this query; did you mean \`${replacement}\`?`,
    };
}

function ambiguousColumn(sql: string, error: string, schema: SchemaInfo): Repair | null {
    const column = /column reference "([^"]+)" is ambiguous/.exec(error)?.[1];
    if (!column) return null;
    const owner = tableRefs(sql).find((ref) => schema.get(ref.table)?.includes(column));
    if (!owner) return null;
    const qualifier = owner.alias ?? owner.table;
    return {
        sql: replaceWords(sql, (token, prev) => token.text.toLowerCase() === column && prev?.toLowerCase() !== "as", `${qualifier}.${column}`, true),
        note: `\`${column}\` exists in more than one joined table; qualified it as \`${qualifier}.${column}\`.`,
    };
}

function unknownFunction(sql: string, error: string): Repair | null {
    const name = /function (\w+)\(.*\) does not exist/.exec(error)?.[1];
    if (!name) return null;
    const replacement = closest(name, FUNCTIONS);
    if (!replacement) return null;
    return {
        sql: replaceWords(sql, (token, _prev, next) => token.text.toLowerCase() === name.toLowerCase() && next === "(", replacement),
        note: `There is no function \`${name}\`; \`${replacement}\` looks intended.`,
    };
}

function syntaxError(sql: string, error: string, schema: SchemaInfo): Repair | null {
    if (!/syntax error/.test(error)) return null;
    const tokens = lexSql(sql);
    const known = new Set<string>([...schema.keys(), ...[...schema.values()].flat(), ...aliasMap(sql).keys()]);

    // GROUP / ORDER without BY.
    for (let i = 0; i < tokens.length; i++) {
        const word = tokens[i]!.text.toLowerCase();
        if ((word === "group" || word === "order") && tokens[i]!.kind === "word" && tokens[i + 1]?.text.toLowerCase() !== "by") {
            const end = tokens[i]!.start + tokens[i]!.text.length;
            return { sql: `${sql.slice(0, end)} by${sql.slice(end)}`, note: `\`${word.toUpperCase()}\` needs \`BY\`.` };
        }
    }
    // A misspelled keyword: a bare word that is neither an identifier we know nor a keyword.
    for (const [i, token] of tokens.entries()) {
        if (token.kind !== "word") continue;
        const word = token.text.toLowerCase();
        if (KEYWORDS.includes(word) || FUNCTIONS.includes(word) || known.has(word) || tokens[i + 1]?.text === "(") continue;
        if (tokens[i - 1]?.text.toLowerCase() === "as") continue;
        const keyword = closest(word, KEYWORDS);
        if (keyword && keyword.length > 2) {
            return {
                sql: sql.slice(0, token.start) + keyword + sql.slice(token.start + token.text.length),
                note: `\`${token.text}\` looks like a misspelled \`${keyword.toUpperCase()}\`.`,
            };
        }
    }
    return null;
}

/** Replaces word tokens (never inside strings or comments) that match `predicate`. */
function replaceWords(
    sql: string,
    predicate: (token: SqlToken, previous: string | undefined, next: string | undefined) => boolean,
    replacement: string,
    skipQualified = false,
): string {
    const tokens = lexSql(sql);
    let out = "";
    let cursor = 0;
    tokens.forEach((token, i) => {
        if (token.kind !== "word") return;
        const prevText = tokens[i - 1]?.text === "." ? tokens[i - 2]?.text : undefined;
        if (skipQualified && tokens[i - 1]?.text === ".") return;
        if (!predicate(token, prevText ?? (skipQualified ? tokens[i - 1]?.text : undefined), tokens[i + 1]?.text)) return;
        out += sql.slice(cursor, token.start) + replacement;
        cursor = token.start + token.text.length;
    });
    return out + sql.slice(cursor);
}
