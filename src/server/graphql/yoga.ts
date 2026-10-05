import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSchema, createYoga } from "graphql-yoga";
import { resolvers, type GraphQLContext } from "./resolvers.ts";

export const typeDefs = readFileSync(join(import.meta.dirname, "schema.graphql"), "utf8");

export type Yoga = ReturnType<typeof createGraphQL>;

export function createGraphQL(context: GraphQLContext) {
    return createYoga<GraphQLContext>({
        schema: createSchema<GraphQLContext>({ typeDefs, resolvers }),
        context: () => context,
        graphqlEndpoint: "/graphql",
        // Unexpected errors reach the client as "Unexpected error."; GraphQLErrors thrown on purpose pass through.
        maskedErrors: true,
        logging: process.env.NODE_ENV === "test" ? "error" : "warn",
    });
}
