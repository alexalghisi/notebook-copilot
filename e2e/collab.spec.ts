import { expect, test, type Page } from "@playwright/test";

const A = "http://localhost:4720";
const B = "http://localhost:4721";

async function createNotebook(): Promise<string> {
    const response = await fetch(`${A}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `mutation { createNotebook(title: "Shop analysis", fromTemplate: true) { id } }` }),
    });
    const body = (await response.json()) as { data: { createNotebook: { id: string } } };
    return body.data.createNotebook.id;
}

function editor(page: Page, index: number) {
    return page.getByTestId("cell").nth(index).locator(".cm-content");
}

/** The cell's text as the editor shows it, without collaborators' cursor labels. */
function source(page: Page, index: number): Promise<string> {
    return editor(page, index).evaluate((el) =>
        [...el.querySelectorAll(".cm-line")]
            .map((line) => {
                const copy = line.cloneNode(true) as HTMLElement;
                copy.querySelectorAll(".cm-ySelectionInfo").forEach((info) => info.remove());
                return (copy.textContent ?? "").replace(/[\u2060\u200b]/g, "");
            })
            .join("\n"),
    );
}

async function open(page: Page, base: string, id: string, user: string): Promise<void> {
    await page.goto(`${base}/?nb=${id}&user=${user}`);
    await expect(page.getByTestId("connection-status")).toHaveText("Live");
    await expect(page.getByTestId("cell")).toHaveCount(4);
}

test("two browsers on different servers edit the same cell and see each other", async ({ browser }) => {
    const id = await createNotebook();
    const ada = await (await browser.newContext()).newPage();
    const grace = await (await browser.newContext()).newPage();
    await open(ada, A, id, "Ada");
    await open(grace, B, id, "Grace");

    await expect(ada.getByTestId("peers")).toContainText("Grace");
    await expect(grace.getByTestId("peers")).toContainText("Grace (you)");
    await expect(grace.getByTestId("peers")).toContainText("Ada");

    // Both type into the first SQL cell at the same time, at different ends.
    await editor(ada, 1).click();
    await ada.keyboard.press("ControlOrMeta+Home");
    await editor(grace, 1).click();
    await grace.keyboard.press("ControlOrMeta+End");
    await Promise.all([ada.keyboard.type("-- by Ada\n", { delay: 15 }), grace.keyboard.type("\nlimit 3", { delay: 15 })]);

    const expected = "-- by Ada\nselect country, count(*) as customers\nfrom customers\ngroup by country\norder by customers desc\nlimit 3";
    for (const page of [ada, grace]) {
        await expect.poll(() => source(page, 1)).toBe(expected);
    }

    // Running it on one side shows the stored result on the other.
    await grace.getByTestId("cell").nth(1).getByTestId("run-cell").click();
    await expect(ada.getByTestId("cell").nth(1).getByTestId("cell-result")).toContainText("3 rows");
});

test("edits made offline merge when the browser reconnects", async ({ browser }) => {
    const id = await createNotebook();
    const ada = await (await browser.newContext()).newPage();
    const grace = await (await browser.newContext()).newPage();
    await open(ada, A, id, "Ada");
    await open(grace, B, id, "Grace");

    // Browsers keep open websockets when network emulation goes offline, so use the app's own switch.
    await ada.getByTestId("connection-status").click();
    await expect(ada.getByTestId("connection-status")).toContainText("Offline");
    await editor(ada, 2).click();
    await ada.keyboard.press("ControlOrMeta+End");
    await ada.keyboard.type("\nlimit 2");
    await editor(grace, 2).click();
    await grace.keyboard.press("ControlOrMeta+Home");
    await grace.keyboard.type("-- revenue\n");

    await expect.poll(() => source(ada, 2)).not.toContain("-- revenue");
    await ada.getByTestId("connection-status").click();
    await expect(ada.getByTestId("connection-status")).toHaveText("Live", { timeout: 15_000 });
    for (const page of [ada, grace]) {
        await expect.poll(() => source(page, 2), { timeout: 10_000 }).toMatch(/^-- revenue\nselect p\.category[\s\S]*limit 2$/);
    }
});

test("the copilot fixes a broken cell and both browsers get the fix", async ({ browser }) => {
    const id = await createNotebook();
    const ada = await (await browser.newContext()).newPage();
    const grace = await (await browser.newContext()).newPage();
    await open(ada, A, id, "Ada");
    await open(grace, B, id, "Grace");

    const broken = ada.getByTestId("cell").nth(3);
    await broken.getByTestId("run-cell").click();
    await expect(grace.getByTestId("cell").nth(3).getByTestId("cell-error")).toContainText('column o.orderd_at does not exist');

    await broken.getByRole("button", { name: "Fix with copilot" }).click();
    const proposal = ada.getByTestId("proposal");
    await expect(proposal).toContainText("+ select date_trunc('month', o.ordered_at)");
    await expect(ada.getByTestId("copilot-usage")).toContainText("proposed an edit");
    await ada.getByTestId("accept-proposal").click();

    await expect(editor(grace, 3)).toContainText("o.ordered_at");
    await expect(grace.getByTestId("cell").nth(3).getByTestId("cell-result")).toContainText("rows");
});

test("the copilot answers a question with a query", async ({ page }) => {
    const id = await createNotebook();
    await open(page, A, id, "Ada");
    await page.getByTestId("copilot-input").fill("How many orders were refunded?");
    await page.getByTestId("copilot-submit").click();
    await expect(page.getByTestId("copilot-answer")).toContainText(/The answer is \d+\./);
});
