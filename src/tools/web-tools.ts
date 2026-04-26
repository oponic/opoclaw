import { search, fetchWeb } from "../search/index.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

export const WEB_TOOLS = {
    search: defineTool(
        "search",
        "Search the web and return top results.",
        {
            query: {
                type: "string",
                description: "Search query.",
            },
            count: {
                type: "number",
                description: "Max results to return (1-10). Defaults to 5.",
            },
        },
        ["query"],
        {
            handler: async (args, { config }) => {
                if (!args.query) throw new Error("Missing 'query' argument for search.");
                const countRaw = Number(args.count ?? 5);
                const count = Number.isFinite(countRaw) ? Math.min(Math.max(1, countRaw), 10) : 5;
                return await search(String(args.query), count, config);
            },
        },
    ),
    web_fetch: defineTool(
        "web_fetch",
        "Fetch a web page and return its text content.",
        {
            url: {
                type: "string",
                description: "The URL to fetch.",
            },
        },
        ["url"],
        {
            enabled: (config) => config.enable_web_fetch ?? true,
            handler: async (args, { config }) => {
                if (!args.url) throw new Error("Missing 'url' argument for web_fetch.");
                return await fetchWeb(String(args.url), config);
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
