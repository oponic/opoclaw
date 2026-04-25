import { DuckDuckGoSearch } from "../search/duckduckgo.ts";
import { TavilySearch } from "../search/tavily.ts";
import type { SearchResult } from "../search/base.ts";
import { defineTool, type ToolDefinition, type ToolContext } from "./types.ts";
import type { OpoclawConfig } from "../config.ts";

function formatSearchResults(results: SearchResult[], count: number): string {
    if (!results.length) return "(no results)";
    return results
        .slice(0, count)
        .map((result, i) => `${i + 1}. ${result.title}\n${result.url}\n${result.snippet}`.trim())
        .join("\n\n");
}

async function fetchWithTimeout(url: string, timeoutMs = 5000, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            headers: { "User-Agent": "opoclaw-bot/1.0" },
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(id);
    }
}

async function tavilyExtract(url: string, apiKey: string, timeoutMs = 15000): Promise<string> {
    const res = await fetchWithTimeout("https://api.tavily.com/extract", timeoutMs, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ urls: url, extract_depth: "basic", format: "markdown" }),
    });
    if (!res.ok) throw new Error(`tavily extract failed (${res.status})`);
    const data: any = await res.json();
    const result = data.results?.[0];
    if (!result) {
        const failed = data.failed_results?.[0];
        throw new Error(failed?.error ?? "tavily extract returned no results");
    }
    return result.raw_content as string;
}

async function webSearch(query: string, count = 5, config: OpoclawConfig): Promise<string> {
    if (config.search_provider === "tavily") {
        if (!config.tavily_api_key) return "Error: Tavily is selected as search provider but no tavily_api_key is set in config.";
        return formatSearchResults(await new TavilySearch(config.tavily_api_key).search(query, count), count);
    }
    return formatSearchResults(await new DuckDuckGoSearch().search(query, count), count);
}

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
                return await webSearch(String(args.query), count, config);
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
                const url = String(args.url);
                if (config.search_provider === "tavily") {
                    if (!config.tavily_api_key) return "Error: Tavily is selected as search provider but no tavily_api_key is set in config.";
                    return await tavilyExtract(url, config.tavily_api_key);
                }
                const res = await fetch(url, { headers: { "User-Agent": "opoclaw-bot/1.0" } });
                if (!res.ok) throw new Error(`web_fetch failed (${res.status})`);
                return await res.text();
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
