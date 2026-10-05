/**
 * The eval suite: 25 copilot tasks over the sample shop database. "fix" tasks start from a
 * cell that fails; "write" tasks start from an empty cell and a request. A task passes
 * when the SQL the copilot proposes returns the same result as the gold query.
 *
 * A few tasks are there because the offline model can't do them (they need knowing that
 * "cost" means price, or reasoning about types and ratios). They keep the pass rate honest
 * and show what a real model adds.
 */
export interface EvalTask {
    id: string;
    kind: "fix" | "write";
    title: string;
    /** Initial cell source: the broken query for fix tasks, empty for write tasks. */
    cell: string;
    prompt: string;
    gold: string;
    /** Compare row order too (the task asks for a ranking or a time series). */
    ordered: boolean;
}

const REVENUE = "sum(oi.quantity * oi.unit_price)";
const SOLD = "o.status in ('paid', 'shipped')";

export const TASKS: EvalTask[] = [
    {
        id: "fix-qualified-column",
        kind: "fix",
        title: "Misspelled qualified column",
        cell: "select date_trunc('month', o.orderd_at) as month, count(*) as orders\nfrom orders o\ngroup by 1\norder by 1",
        prompt: "",
        gold: "select date_trunc('month', o.ordered_at), count(*) from orders o group by 1 order by 1",
        ordered: true,
    },
    {
        id: "fix-table-name",
        kind: "fix",
        title: "Singular table name",
        cell: "select country, count(*) as customers\nfrom customer\ngroup by country",
        prompt: "",
        gold: "select country, count(*) from customers group by country",
        ordered: false,
    },
    {
        id: "fix-missing-group-by",
        kind: "fix",
        title: "Aggregate without GROUP BY",
        cell: "select country, count(*)\nfrom customers",
        prompt: "",
        gold: "select country, count(*) from customers group by country",
        ordered: false,
    },
    {
        id: "fix-keyword-typo",
        kind: "fix",
        title: "Misspelled SELECT",
        cell: "selct name, price\nfrom products\norder by price desc\nlimit 5",
        prompt: "",
        gold: "select name, price from products order by price desc limit 5",
        ordered: true,
    },
    {
        id: "fix-unknown-alias",
        kind: "fix",
        title: "Alias that doesn't exist",
        cell: "select c.name, count(*) as orders\nfrom orders o\njoin customers c on c.id = o.customer_id\ngroup by cc.name\norder by 2 desc, 1\nlimit 10",
        prompt: "",
        gold: "select c.name, count(*) from orders o join customers c on c.id = o.customer_id group by c.name order by 2 desc, 1 limit 10",
        ordered: true,
    },
    {
        id: "fix-ambiguous-column",
        kind: "fix",
        title: "Ambiguous column in a join",
        cell: "select id, name, status\nfrom orders o\njoin customers c on c.id = o.customer_id\nwhere status = 'refunded'\norder by o.id\nlimit 20",
        prompt: "",
        gold: "select o.id, c.name, o.status from orders o join customers c on c.id = o.customer_id where o.status = 'refunded' order by o.id limit 20",
        ordered: true,
    },
    {
        id: "fix-group-without-by",
        kind: "fix",
        title: "GROUP without BY",
        cell: "select category, round(avg(price), 2) as avg_price\nfrom products\ngroup category",
        prompt: "",
        gold: "select category, round(avg(price), 2) from products group by category",
        ordered: false,
    },
    {
        id: "fix-function-typo",
        kind: "fix",
        title: "Misspelled aggregate",
        cell: "select country, cont(*)\nfrom customers\ngroup by country",
        prompt: "",
        gold: "select country, count(*) from customers group by country",
        ordered: false,
    },
    {
        id: "fix-group-by-typo",
        kind: "fix",
        title: "Typo in GROUP BY",
        cell: "select status, count(*)\nfrom orders\ngroup by stauts",
        prompt: "",
        gold: "select status, count(*) from orders group by status",
        ordered: false,
    },
    {
        id: "fix-join-table",
        kind: "fix",
        title: "Wrong table in a join",
        cell: "select p.name, sum(oi.quantity) as units\nfrom order_items oi\njoin product p on p.id = oi.product_id\ngroup by p.name\norder by units desc\nlimit 5",
        prompt: "",
        gold: "select p.name, sum(oi.quantity) from order_items oi join products p on p.id = oi.product_id group by p.name order by 2 desc limit 5",
        ordered: true,
    },
    {
        id: "fix-two-errors",
        kind: "fix",
        title: "Two errors, one revealed by fixing the other",
        cell: "selct c.country, count(*)\nfrom orders o\njoin customer c on c.id = o.customer_id\ngroup by c.country",
        prompt: "",
        gold: "select c.country, count(*) from orders o join customers c on c.id = o.customer_id group by c.country",
        ordered: false,
    },
    {
        id: "fix-semantic-column",
        kind: "fix",
        title: "Column named after its meaning (cost means price)",
        cell: "select name, cost\nfrom products\norder by cost desc\nlimit 3",
        prompt: "",
        gold: "select name, price from products order by price desc limit 3",
        ordered: true,
    },
    {
        id: "fix-type-mismatch",
        kind: "fix",
        title: "Comparing a timestamp with a number",
        cell: "select count(*)\nfrom orders\nwhere ordered_at >= 2026",
        prompt: "It should count orders placed since the start of 2026.",
        gold: "select count(*) from orders where ordered_at >= '2026-01-01'",
        ordered: false,
    },
    {
        id: "write-customers-per-country",
        kind: "write",
        title: "Customers per country",
        cell: "",
        prompt: "How many customers are there in each country?",
        gold: "select country, count(*) from customers group by country",
        ordered: false,
    },
    {
        id: "write-top-products-revenue",
        kind: "write",
        title: "Top products by revenue",
        cell: "",
        prompt: "Top 5 products by revenue",
        gold: `select p.name, ${REVENUE} from order_items oi join orders o on o.id = oi.order_id join products p on p.id = oi.product_id where ${SOLD} group by p.name order by 2 desc limit 5`,
        ordered: true,
    },
    {
        id: "write-revenue-by-category",
        kind: "write",
        title: "Revenue by category",
        cell: "",
        prompt: "Total revenue by category",
        gold: `select p.category, ${REVENUE} from order_items oi join orders o on o.id = oi.order_id join products p on p.id = oi.product_id where ${SOLD} group by p.category`,
        ordered: false,
    },
    {
        id: "write-orders-per-month",
        kind: "write",
        title: "Orders per month",
        cell: "",
        prompt: "Number of orders per month",
        gold: "select date_trunc('month', ordered_at), count(*) from orders group by 1 order by 1",
        ordered: true,
    },
    {
        id: "write-aov-by-country",
        kind: "write",
        title: "Average order value by country",
        cell: "",
        prompt: "Average order value by country",
        gold: `select country, round(avg(total), 2) from (
            select o.id, c.country, ${REVENUE} as total
            from order_items oi join orders o on o.id = oi.order_id join customers c on c.id = o.customer_id
            where ${SOLD} group by o.id, c.country) t group by country`,
        ordered: false,
    },
    {
        id: "write-refunded-count",
        kind: "write",
        title: "Refunded orders",
        cell: "",
        prompt: "How many orders were refunded?",
        gold: "select count(*) from orders where status = 'refunded'",
        ordered: false,
    },
    {
        id: "write-top-spenders",
        kind: "write",
        title: "Customers who spent the most",
        cell: "",
        prompt: "Which 10 customers spent the most?",
        gold: `select c.name, ${REVENUE} from order_items oi join orders o on o.id = oi.order_id join customers c on c.id = o.customer_id where ${SOLD} group by c.id, c.name order by 2 desc limit 10`,
        ordered: true,
    },
    {
        id: "write-orders-by-status",
        kind: "write",
        title: "Orders by status",
        cell: "",
        prompt: "Count of orders by status",
        gold: "select status, count(*) from orders group by status",
        ordered: false,
    },
    {
        id: "write-electronics-by-price",
        kind: "write",
        title: "Products in a category, by price",
        cell: "",
        prompt: "List the products in the Electronics category ordered by price",
        gold: "select name, price from products where category = 'Electronics' order by price",
        ordered: true,
    },
    {
        id: "write-inactive-customers",
        kind: "write",
        title: "Customers without orders",
        cell: "",
        prompt: "Which customers have never placed an order?",
        gold: "select name from customers c where not exists (select 1 from orders o where o.customer_id = c.id)",
        ordered: false,
    },
    {
        id: "write-monthly-revenue-2025",
        kind: "write",
        title: "Monthly revenue for one year",
        cell: "",
        prompt: "Monthly revenue in 2025",
        gold: `select date_trunc('month', o.ordered_at), ${REVENUE} from order_items oi join orders o on o.id = oi.order_id where ${SOLD} and o.ordered_at >= '2025-01-01' and o.ordered_at < '2026-01-01' group by 1 order by 1`,
        ordered: true,
    },
    {
        id: "write-cancelled-share",
        kind: "write",
        title: "Share of cancelled orders",
        cell: "",
        prompt: "What percentage of orders were cancelled?",
        gold: "select round(100.0 * count(*) filter (where status = 'cancelled') / count(*), 2) from orders",
        ordered: false,
    },
];
