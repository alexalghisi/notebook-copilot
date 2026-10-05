export interface GqlResponse<T> {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

export async function gql<T>(baseUrl: string, query: string, variables: Record<string, unknown> = {}): Promise<GqlResponse<T>> {
    const response = await fetch(`${baseUrl}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as GqlResponse<T>;
}
