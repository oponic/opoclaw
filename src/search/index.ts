export type { SearchResult, SearchProvider } from "./types.ts";

import type { OpoclawConfig } from "../config.ts";
import { DuckDuckGoSearch } from "./duckduckgo.ts";
import { TavilySearch } from "./tavily.ts";
import type { SearchResult } from "./types.ts";

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

export async function search(query: string, count: number, config: OpoclawConfig): Promise<string> {
    if (config.search_provider === "tavily") {
        if (!config.tavily_api_key) return "Error: Tavily is selected as search provider but no tavily_api_key is set in config.";
        return formatSearchResults(await new TavilySearch(config.tavily_api_key).search(query, count), count);
    }
    return formatSearchResults(await new DuckDuckGoSearch().search(query, count), count);
}

export async function fetchWeb(url: string, config: OpoclawConfig): Promise<string> {
    if (config.search_provider === "tavily") {
        if (!config.tavily_api_key) return "Error: Tavily is selected as search provider but no tavily_api_key is set in config.";
        const res = await fetchWithTimeout("https://api.tavily.com/extract", 15000, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${config.tavily_api_key}`,
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
    const res = await fetch(url, { headers: { "User-Agent": "opoclaw-bot/1.0" } });
    if (!res.ok) throw new Error(`web_fetch failed (${res.status})`);
    return await res.text();
}
