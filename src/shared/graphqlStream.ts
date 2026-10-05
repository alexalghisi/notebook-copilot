export interface GraphQLErrorShape {
    message: string;
    extensions?: { code?: string };
}

/**
 * Runs a GraphQL subscription over Server-Sent Events (the "distinct connections" mode
 * graphql-yoga serves on its normal endpoint) and yields each `data` payload. Plain
 * fetch, so it works the same in the browser and in Node tests.
 */
export async function* subscribe<T>(
    endpoint: string,
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
): AsyncGenerator<T> {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ query, variables }),
        ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) throw new Error(`subscription failed with HTTP ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += value;
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const event = /^event: (.*)$/m.exec(block)?.[1];
                const data = block
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                if (event === "complete") return;
                if (!data) continue;
                const payload = JSON.parse(data) as { data?: T; errors?: GraphQLErrorShape[] };
                if (payload.errors?.length) throw new Error(payload.errors.map((e) => e.message).join("; "));
                if (payload.data) yield payload.data;
            }
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}
