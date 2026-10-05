/**
 * The offline model's way of writing SQL: a tiny semantic layer over the shop schema.
 * A question is mapped to a measure, at most one dimension, filters, a limit and an
 * ordering, and the SQL is generated from that plan with the joins it needs. It covers the
 * common shapes ("top 5 products by revenue", "orders per month in 2025") and knowingly
 * fails on anything else, which the eval suite reports.
 */
type Measure = "revenue" | "orders" | "customers" | "products" | "avg_order_value" | "list_products" | "inactive_customers";
type Dimension = "country" | "category" | "product" | "customer" | "month" | "status";
type Alias = "oi" | "o" | "c" | "p";

interface Filter {
    sql: string;
    needs: Alias;
}

export interface QueryPlan {
    measure: Measure;
    dimension: Dimension | null;
    filters: Filter[];
    limit: number | null;
    order: "measure_desc" | "dimension" | "price" | "none";
}

const STATUSES = ["paid", "shipped", "refunded", "cancelled"] as const;
const COUNTRIES = ["Romania", "Italy", "Germany", "France", "Spain", "Netherlands", "Poland", "Czechia"];
const NUMBER_WORDS: Record<string, number> = { three: 3, five: 5, ten: 10, twenty: 20 };

const DIMENSIONS: Array<[RegExp, Dimension]> = [
    [/\b(per|by|each|every|for each)\s+(month|monthly)\b|\bmonthly\b|\bper month\b/, "month"],
    [/\b(per|by|each|in each|for each)\s+country\b|\bcountr(y|ies)\b/, "country"],
    [/\b(per|by|each|for each)\s+(product )?category\b|\bcategor(y|ies)\b/, "category"],
    [/\b(per|by|each|for each)\s+status\b|\bstatus(es)?\b/, "status"],
    [/\bproducts?\b/, "product"],
    [/\bcustomers?\b/, "customer"],
];

export function planQuestion(question: string): QueryPlan | null {
    const q = question.toLowerCase();
    const filters: Filter[] = [];
    const limit = topN(q);

    if (/never (placed|made|ordered)|without (any )?orders|no orders/.test(q) && /customer/.test(q)) {
        return { measure: "inactive_customers", dimension: null, filters: [], limit: null, order: "none" };
    }

    const status = STATUSES.find((s) => new RegExp(`\\b${s}\\b`).test(q));
    if (status) filters.push({ sql: `o.status = '${status}'`, needs: "o" });
    const country = COUNTRIES.find((c) => new RegExp(`\\b${c.toLowerCase()}\\b`).test(q));
    if (country) filters.push({ sql: `c.country = '${country}'`, needs: "c" });
    const year = /\b(?:in|during|for)\s+(20\d\d)\b/.exec(q)?.[1];
    const category = /\b(?:in the|in|from the)\s+([a-z]+)\s+category\b/.exec(q)?.[1];
    if (category) filters.push({ sql: `p.category = '${category[0]!.toUpperCase()}${category.slice(1)}'`, needs: "p" });

    let measure: Measure | null = null;
    if (/average order value|avg order value|average basket/.test(q)) measure = "avg_order_value";
    else if (/revenue|sales|spent|spend|earn|income/.test(q)) measure = "revenue";
    else if (/\b(how many|number of|count( of)?)\b.*\borders?\b|\borders? (per|by|each)\b/.test(q)) measure = "orders";
    else if (/\b(how many|number of|count( of)?)\b.*\bcustomers?\b/.test(q)) measure = "customers";
    else if (/\b(how many|number of|count( of)?)\b.*\bproducts?\b/.test(q)) measure = "products";
    else if (/\b(list|show|which|what)\b.*\bproducts\b|\bproducts (in|from)\b/.test(q)) measure = "list_products";
    if (!measure) return null;

    if (year) filters.push({ sql: `o.ordered_at >= '${year}-01-01' and o.ordered_at < '${Number(year) + 1}-01-01'`, needs: "o" });

    let dimension: Dimension | null = null;
    for (const [pattern, dim] of DIMENSIONS) {
        if (!pattern.test(q)) continue;
        // The measure's own entity isn't a dimension: "how many customers" is not "per customer".
        if ((measure === "customers" && dim === "customer") || ((measure === "products" || measure === "list_products") && dim === "product")) continue;
        if (measure === "orders" && dim === "status" && status) continue;
        if (dim === "category" && category) continue;
        if (dim === "country" && country && !/\b(per|by|each)\s+country\b/.test(q)) continue;
        dimension = dim;
        break;
    }
    if (measure === "revenue" && /\bwho\b|\bcustomers?\b.*\b(spent|spend)\b/.test(q)) dimension = "customer";
    if (measure === "list_products") dimension = null;

    const order: QueryPlan["order"] =
        measure === "list_products" ? (/\bprice\b/.test(q) ? "price" : "none") : dimension === "month" ? "dimension" : limit !== null || /\b(top|most|best|highest)\b/.test(q) ? "measure_desc" : "none";
    return { measure, dimension, filters, limit, order };
}

function topN(q: string): number | null {
    const match = /\b(?:top|first|best|limit)\s+(\d+|three|five|ten|twenty)\b|\b(\d+|three|five|ten|twenty)\s+(?:customers|products|countries|categories)\b/.exec(q);
    const raw = match?.[1] ?? match?.[2];
    if (!raw) return null;
    return NUMBER_WORDS[raw] ?? Number.parseInt(raw, 10);
}

// Names aren't unique (two customers can share one), so entity dimensions group by id too.
const DIM_SQL: Record<Dimension, { expr: string; name: string; needs: Alias; groupBy?: string }> = {
    country: { expr: "c.country", name: "country", needs: "c" },
    category: { expr: "p.category", name: "category", needs: "p" },
    product: { expr: "p.name", name: "product", needs: "p", groupBy: "p.id, p.name" },
    customer: { expr: "c.name", name: "customer", needs: "c", groupBy: "c.id, c.name" },
    month: { expr: "date_trunc('month', o.ordered_at)", name: "month", needs: "o" },
    status: { expr: "o.status", name: "status", needs: "o" },
};

export function buildSql(plan: QueryPlan): string {
    if (plan.measure === "inactive_customers") {
        return "select c.name, c.email\nfrom customers c\nwhere not exists (select 1 from orders o where o.customer_id = c.id)\norder by c.name";
    }
    if (plan.measure === "list_products") {
        const where = plan.filters.filter((f) => f.needs === "p").map((f) => f.sql);
        return [
            "select p.name, p.category, p.price",
            "from products p",
            where.length ? `where ${where.join(" and ")}` : null,
            plan.order === "price" ? "order by p.price" : "order by p.name",
            plan.limit ? `limit ${plan.limit}` : null,
        ]
            .filter(Boolean)
            .join("\n");
    }

    const needs = new Set<Alias>(plan.filters.map((f) => f.needs));
    const dim = plan.dimension ? DIM_SQL[plan.dimension] : null;
    if (dim) needs.add(dim.needs);
    const where = plan.filters.map((f) => f.sql);
    let select: string;
    let measureName: string;

    if (plan.measure === "avg_order_value") {
        needs.add("o");
        const extraCols = dim ? `, ${dim.expr} as ${dim.name}` : "";
        const inner = buildFrom(new Set<Alias>([...needs, "oi", "o"]));
        const innerWhere = ["o.status in ('paid', 'shipped')", ...where];
        return [
            `select ${dim ? `t.${dim.name}, ` : ""}round(avg(t.total), 2) as avg_order_value`,
            "from (",
            `    select o.id${extraCols}, sum(oi.quantity * oi.unit_price) as total`,
            `    ${inner.join("\n    ")}`,
            `    where ${innerWhere.join(" and ")}`,
            `    group by o.id${dim ? `, ${dim.expr}` : ""}`,
            ") t",
            dim ? `group by t.${dim.name}` : null,
            dim ? `order by ${plan.order === "dimension" ? `t.${dim.name}` : "avg_order_value desc"}` : null,
            plan.limit ? `limit ${plan.limit}` : null,
        ]
            .filter(Boolean)
            .join("\n");
    }

    switch (plan.measure) {
        case "revenue":
            needs.add("oi").add("o");
            where.unshift("o.status in ('paid', 'shipped')");
            select = "sum(oi.quantity * oi.unit_price) as revenue";
            measureName = "revenue";
            break;
        case "orders":
            needs.add("o");
            select = needs.has("oi") || needs.has("p") ? "count(distinct o.id) as orders" : "count(*) as orders";
            measureName = "orders";
            break;
        case "customers":
            needs.add("c");
            select = needs.has("o") ? "count(distinct c.id) as customers" : "count(*) as customers";
            measureName = "customers";
            break;
        default:
            needs.add("p");
            select = "count(*) as products";
            measureName = "products";
    }

    const lines = [`select ${dim ? `${dim.expr} as ${dim.name}, ` : ""}${select}`, ...buildFrom(needs)];
    if (where.length) lines.push(`where ${where.join("\n  and ")}`);
    if (dim) lines.push(`group by ${dim.groupBy ?? dim.expr}`);
    if (dim && plan.order === "dimension") lines.push(`order by ${dim.name}`);
    else if (dim && (plan.order === "measure_desc" || plan.limit)) lines.push(`order by ${measureName} desc`);
    else if (dim) lines.push(`order by ${measureName} desc`);
    if (plan.limit) lines.push(`limit ${plan.limit}`);
    return lines.join("\n");
}

function buildFrom(needs: Set<Alias>): string[] {
    if (needs.has("p") && (needs.has("o") || needs.has("c"))) needs.add("oi");
    if (needs.has("oi") && needs.has("c")) needs.add("o");
    if (needs.has("c") && needs.has("oi")) needs.add("o");
    const lines: string[] = [];
    if (needs.has("oi")) {
        lines.push("from order_items oi");
        if (needs.has("o")) lines.push("join orders o on o.id = oi.order_id");
        if (needs.has("c")) lines.push("join customers c on c.id = o.customer_id");
        if (needs.has("p")) lines.push("join products p on p.id = oi.product_id");
    } else if (needs.has("o")) {
        lines.push("from orders o");
        if (needs.has("c")) lines.push("join customers c on c.id = o.customer_id");
    } else if (needs.has("c")) {
        lines.push("from customers c");
    } else {
        lines.push("from products p");
    }
    return lines;
}

export function questionToSql(question: string): string | null {
    const plan = planQuestion(question);
    return plan ? buildSql(plan) : null;
}
