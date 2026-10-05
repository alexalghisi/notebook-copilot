import type { CellType } from "../shared/notebook.ts";

/** The notebook new users start from; the last SQL cell is broken on purpose. */
export const SHOP_ANALYSIS: ReadonlyArray<{ type: CellType; source: string }> = [
    {
        type: "markdown",
        source: "# Shop analysis\nOrders, customers and revenue from the sample shop. Revenue counts paid and shipped orders only.",
    },
    {
        type: "sql",
        source: "select country, count(*) as customers\nfrom customers\ngroup by country\norder by customers desc",
    },
    {
        type: "sql",
        source: [
            "select p.category, sum(oi.quantity * oi.unit_price) as revenue",
            "from order_items oi",
            "join products p on p.id = oi.product_id",
            "join orders o on o.id = oi.order_id",
            "where o.status in ('paid', 'shipped')",
            "group by p.category",
            "order by revenue desc",
        ].join("\n"),
    },
    {
        type: "sql",
        source: "-- monthly orders per country\nselect date_trunc('month', o.orderd_at) as month, c.country, count(*)\nfrom orders o\njoin customers c on c.id = o.customer_id\ngroup by 1, 2\norder by 1, 2",
    },
];
