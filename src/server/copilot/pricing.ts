import type { Usage } from "./model.ts";

/** USD per million tokens. Unknown models cost nothing rather than a made-up number. */
export interface Price {
    input: number;
    output: number;
}

const PRICES: Record<string, Price> = {
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1": { input: 2, output: 8 },
};

export function priceFor(model: string): Price {
    const known = Object.keys(PRICES)
        .sort((a, b) => b.length - a.length)
        .find((prefix) => model === prefix || model.startsWith(`${prefix}-`));
    return known ? PRICES[known]! : { input: 0, output: 0 };
}

export function costUsd(usage: Usage, price: Price): number {
    return (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
}
