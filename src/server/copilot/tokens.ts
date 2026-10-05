import { countTokens as count, decode, encode } from "gpt-tokenizer";

/**
 * Token counting with o200k_base, the encoding of current OpenAI chat models. Other
 * providers tokenize differently, so budgets computed here are close but not exact for
 * them; the context builder keeps a margin for that reason.
 */
export function countTokens(text: string): number {
    return text.length === 0 ? 0 : count(text);
}

/** Keeps a prefix of `text` that is at most `maxTokens` long, cut at a token boundary. */
export function truncateToTokens(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return "";
    const tokens = encode(text);
    if (tokens.length <= maxTokens) return text;
    return decode(tokens.slice(0, maxTokens));
}
