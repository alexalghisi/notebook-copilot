import type pg from "pg";

/**
 * A small shop dataset for SQL cells, copilot tools and evals. It is generated from a
 * fixed seed so every machine (and CI) has identical rows, which is what lets the eval
 * suite compare query results exactly.
 */
export const SAMPLE_DDL = `
CREATE TABLE customers (
    id          integer PRIMARY KEY,
    name        text NOT NULL,
    email       text NOT NULL UNIQUE,
    country     text NOT NULL,
    signup_date date NOT NULL
);
CREATE TABLE products (
    id       integer PRIMARY KEY,
    name     text NOT NULL,
    category text NOT NULL,
    price    numeric(10, 2) NOT NULL
);
CREATE TABLE orders (
    id          integer PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers(id),
    ordered_at  timestamptz NOT NULL,
    status      text NOT NULL CHECK (status IN ('paid', 'shipped', 'refunded', 'cancelled'))
);
CREATE TABLE order_items (
    order_id   integer NOT NULL REFERENCES orders(id),
    product_id integer NOT NULL REFERENCES products(id),
    quantity   integer NOT NULL CHECK (quantity > 0),
    unit_price numeric(10, 2) NOT NULL,
    PRIMARY KEY (order_id, product_id)
);
CREATE INDEX orders_customer_idx ON orders (customer_id);
CREATE INDEX order_items_product_idx ON order_items (product_id);
COMMENT ON TABLE customers IS 'People who signed up to the shop';
COMMENT ON TABLE orders IS 'One row per checkout; revenue counts only paid and shipped orders';
COMMENT ON COLUMN order_items.unit_price IS 'Price at the time of the order, may differ from products.price';
`;

const COUNTRIES = ["Romania", "Italy", "Germany", "France", "Spain", "Netherlands", "Poland", "Czechia"] as const;
const FIRST = ["Ana", "Luca", "Mara", "Paul", "Elena", "Marco", "Ioana", "Jonas", "Sofia", "Tomas", "Clara", "Mihai"] as const;
const LAST = ["Popescu", "Rossi", "Muller", "Martin", "Garcia", "Jansen", "Nowak", "Novak", "Ionescu", "Bianchi"] as const;
const CATALOG: ReadonlyArray<readonly [string, string, number]> = [
    ["Laptop", "Electronics", 1199],
    ["Monitor", "Electronics", 249],
    ["Keyboard", "Electronics", 79],
    ["Mouse", "Electronics", 35],
    ["Headphones", "Electronics", 149],
    ["Webcam", "Electronics", 89],
    ["Desk", "Furniture", 399],
    ["Chair", "Furniture", 289],
    ["Lamp", "Furniture", 45],
    ["Bookshelf", "Furniture", 159],
    ["Notebook", "Stationery", 6],
    ["Pen set", "Stationery", 12],
    ["Planner", "Stationery", 18],
    ["Backpack", "Accessories", 69],
    ["Water bottle", "Accessories", 22],
    ["Phone case", "Accessories", 19],
    ["Coffee beans", "Grocery", 16],
    ["Green tea", "Grocery", 9],
    ["Dark chocolate", "Grocery", 4],
    ["Olive oil", "Grocery", 14],
];
const STATUSES = ["paid", "paid", "shipped", "shipped", "shipped", "refunded", "cancelled"] as const;

/** mulberry32: tiny, fast and identical everywhere. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<T>(random: () => number, items: readonly T[]): T {
    return items[Math.floor(random() * items.length)] as T;
}

export interface SampleData {
    customers: Array<[number, string, string, string, string]>;
    products: Array<[number, string, string, string]>;
    orders: Array<[number, number, string, string]>;
    orderItems: Array<[number, number, number, string]>;
}

export function generateSampleData(seed = 7): SampleData {
    const random = rng(seed);
    const day = 86_400_000;
    const start = Date.UTC(2025, 0, 1);

    const customers: SampleData["customers"] = [];
    for (let id = 1; id <= 200; id++) {
        const first = pick(random, FIRST);
        const last = pick(random, LAST);
        const signup = new Date(start + Math.floor(random() * 365) * day).toISOString().slice(0, 10);
        customers.push([id, `${first} ${last}`, `${first}.${last}.${id}@example.com`.toLowerCase(), pick(random, COUNTRIES), signup]);
    }

    const products: SampleData["products"] = CATALOG.map(([name, category, price], i) => [i + 1, name, category, price.toFixed(2)]);

    const orders: SampleData["orders"] = [];
    const orderItems: SampleData["orderItems"] = [];
    for (let id = 1; id <= 2000; id++) {
        const customer = customers[Math.floor(random() ** 1.6 * customers.length)]!;
        const signup = Date.parse(customer[4]);
        const at = signup + Math.floor(random() * (Date.UTC(2026, 5, 30) - signup));
        orders.push([id, customer[0], new Date(at - (at % 60_000)).toISOString(), pick(random, STATUSES)]);
        const lines = 1 + Math.floor(random() * 3);
        const used = new Set<number>();
        for (let l = 0; l < lines; l++) {
            const product = products[Math.floor(random() ** 1.3 * products.length)]!;
            if (used.has(product[0])) continue;
            used.add(product[0]);
            // Prices drift a little over time, so unit_price is not always the list price.
            const drift = random() < 0.2 ? 0.9 : 1;
            orderItems.push([id, product[0], 1 + Math.floor(random() * 3), (Number(product[3]) * drift).toFixed(2)]);
        }
    }
    return { customers, products, orders, orderItems };
}

/** Creates the tables in an empty database and loads the generated rows. */
export async function loadSampleData(client: pg.ClientBase, seed = 7): Promise<void> {
    const data = generateSampleData(seed);
    await client.query("BEGIN");
    await client.query(SAMPLE_DDL);
    const columns = <T extends unknown[]>(rows: T[], index: number) => rows.map((row) => row[index]);
    await client.query(
        `INSERT INTO customers SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::date[])`,
        [0, 1, 2, 3, 4].map((i) => columns(data.customers, i)),
    );
    await client.query(
        `INSERT INTO products SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::numeric[])`,
        [0, 1, 2, 3].map((i) => columns(data.products, i)),
    );
    await client.query(
        `INSERT INTO orders SELECT * FROM unnest($1::int[], $2::int[], $3::timestamptz[], $4::text[])`,
        [0, 1, 2, 3].map((i) => columns(data.orders, i)),
    );
    await client.query(
        `INSERT INTO order_items SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::numeric[])`,
        [0, 1, 2, 3].map((i) => columns(data.orderItems, i)),
    );
    await client.query("COMMIT");
    await client.query("ANALYZE");
}
