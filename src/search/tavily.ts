import type { SearchProvider, SearchResult } from "./types.ts";

export class TavilySearch implements SearchProvider {
    name = "tavily";
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async search(query: string, maxResults = 5, timeoutMs = 10000): Promise<SearchResult[]> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch("https://api.tavily.com/search", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    query,
                    max_results: Math.min(Math.max(1, maxResults), 20),
                    search_depth: "basic",
                }),
                signal: controller.signal,
            });
            if (!res.ok) return [];
            const data: any = await res.json();
            const results: SearchResult[] = (data.results ?? []).map((r: any) => ({
                title: String(r.title ?? ""),
                url: String(r.url ?? ""),
                snippet: String(r.content ?? ""),
                source: "tavily",
            }));
            return results;
        } catch {
            return [];
        } finally {
            clearTimeout(id);
        }
    }
}
