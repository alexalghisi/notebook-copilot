export async function waitFor(check: () => boolean | Promise<boolean>, { timeoutMs = 5_000, intervalMs = 20, message = "condition" } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${message}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}
