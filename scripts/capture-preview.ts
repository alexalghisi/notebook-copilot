/**
 * Records the README preview from the real app: two browsers, each connected to its own
 * server process, editing one notebook, then the copilot fixing a broken cell.
 * Writes PNG frames and a manifest; scripts/make_gif.py assembles them.
 *
 *   npm run build && npx tsx scripts/capture-preview.ts && .venv/bin/python scripts/make_gif.py
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { startServerProcess } from "../test/helpers/serverProcess.ts";

const OUT = join(import.meta.dirname, "..", "docs", "frames");
const VIEWPORT = { width: 600, height: 540 };

interface Frame {
    left: string;
    right: string;
    caption: string;
    durationMs: number;
}

const frames: Frame[] = [];
let caption = "";

async function snap(a: Page, b: Page, durationMs = 120): Promise<void> {
    const index = String(frames.length).padStart(4, "0");
    const left = `${index}-a.png`;
    const right = `${index}-b.png`;
    await Promise.all([a.screenshot({ path: join(OUT, left) }), b.screenshot({ path: join(OUT, right) })]);
    frames.push({ left, right, caption, durationMs });
}

async function hold(a: Page, b: Page, ms: number): Promise<void> {
    await snap(a, b, ms);
}

function cell(page: Page, index: number) {
    return page.getByTestId("cell").nth(index);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const env = { STATIC_DIR: "dist", OFFLINE_MODEL_DELAY_MS: "70" };
const servers = await Promise.all([startServerProcess(env), startServerProcess(env)]);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
try {
    const response = await fetch(`${servers[0].url}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `mutation { createNotebook(title: "Shop analysis", fromTemplate: true) { id } }` }),
    });
    const id = ((await response.json()) as { data: { createNotebook: { id: string } } }).data.createNotebook.id;

    const a = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    const b = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    await a.goto(`${servers[0].url}/?nb=${id}&user=Ada`);
    await b.goto(`${servers[1].url}/?nb=${id}&user=Grace`);
    for (const page of [a, b]) {
        await page.getByTestId("connection-status").getByText("Live").waitFor();
        await page.addStyleTag({ content: ".cm-cursor { border-left-width: 2px !important; }" });
    }

    caption = "Two browsers, each on its own server process, one notebook";
    await hold(a, b, 1800);

    caption = "Both type into the same cell; edits merge through the Yjs CRDT";
    const edA = cell(a, 1).locator(".cm-content");
    const edB = cell(b, 1).locator(".cm-content");
    await edA.click();
    await a.keyboard.press("ControlOrMeta+Home");
    await edB.click();
    await b.keyboard.press("ControlOrMeta+End");
    const typedA = "-- customers per country\n";
    const typedB = "\nlimit 5";
    for (let i = 0; i < Math.max(typedA.length, typedB.length); i++) {
        if (i < typedA.length) await a.keyboard.type(typedA[i]!);
        if (i < typedB.length) await b.keyboard.type(typedB[i]!);
        if (i % 2 === 1) await snap(a, b, 90);
    }
    await a.waitForTimeout(300);
    await hold(a, b, 1400);

    caption = "Grace runs it; the result is stored once and shows up for Ada too";
    await cell(b, 1).getByTestId("run-cell").click();
    await cell(a, 1).getByTestId("cell-result").waitFor();
    await hold(a, b, 2200);

    caption = "Grace runs the last cell: it fails";
    for (const page of [a, b]) await cell(page, 3).scrollIntoViewIfNeeded();
    await cell(b, 3).getByTestId("run-cell").click();
    await cell(a, 3).getByTestId("cell-error").waitFor();
    for (const page of [a, b]) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await a.evaluate(() => document.querySelector('[data-testid="cell"]:nth-of-type(4)')?.scrollIntoView({ block: "start" }));
    await b.evaluate(() => document.querySelector('[data-testid="cell"]:nth-of-type(4)')?.scrollIntoView({ block: "start" }));
    await hold(a, b, 2200);

    caption = "Ada asks the copilot to fix it: schema lookup, a test query, then a proposed diff";
    await cell(a, 3).getByRole("button", { name: "Fix with copilot" }).click();
    await a.getByTestId("copilot-session").waitFor();
    const followPanel = () => a.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    for (let i = 0; i < 80; i++) {
        await followPanel();
        await snap(a, b, 160);
        if (await a.getByTestId("copilot-usage").isVisible()) break;
    }
    await a.getByTestId("copilot-usage").waitFor();
    await followPanel();
    await hold(a, b, 2800);

    caption = "Ada accepts; the edit goes through the CRDT and Grace sees the fix and the new result";
    await a.getByTestId("accept-proposal").click();
    await cell(b, 3).getByTestId("cell-result").waitFor();
    await b.evaluate(() => document.querySelector('[data-testid="cell"]:nth-of-type(4)')?.scrollIntoView({ block: "start" }));
    await a.evaluate(() => document.querySelector('[data-testid="cell"]:nth-of-type(4)')?.scrollIntoView({ block: "start" }));
    await a.waitForTimeout(300);
    await hold(a, b, 4000);

    await writeFile(join(OUT, "manifest.json"), JSON.stringify({ viewport: VIEWPORT, labels: ["Ada, server 1", "Grace, server 2"], frames }, null, 2));
    console.log(`${frames.length} frames written to ${OUT}`);
} finally {
    await browser.close();
    await Promise.all(servers.map((s) => s.stop()));
}
