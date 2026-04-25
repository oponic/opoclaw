import type { SearchProvider, SearchResult } from "./types.ts";

function decodeHtmlEntities(input: string): string {
    return input
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");
}

function stripHtml(input: string): string {
    return input.replace(/<[^>]*>/g, "").trim();
}

function getAttr(attrs: string, name: string): string {
    const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i");
    const m = attrs.match(re);
    if (m && m[1]) return m[1];
    const re2 = new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i");
    const m2 = attrs.match(re2);
    return m2 && m2[1] ? m2[1] : "";
}

function parseDuckDuckGoHtml(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = anchorRegex.exec(html))) {
        const attrs = match[1] || "";
        const body = match[2] || "";
        const classAttr = getAttr(attrs, "class");
        const href = decodeHtmlEntities(getAttr(attrs, "href"));
        if (!classAttr) continue;

        if (classAttr.includes("result__a")) {
            const title = decodeHtmlEntities(stripHtml(body));
            if (href && title) {
                results.push({ title, url: href, snippet: "", source: "duckduckgo" });
            }
            continue;
        }

        if (classAttr.includes("result__snippet")) {
            const snippet = decodeHtmlEntities(stripHtml(body)).replace(/\s+/g, " ").trim();
            const last = results[results.length - 1];
            if (last && !last.snippet) {
                last.snippet = snippet;
            }
        }
    }

    return results;
}

export class DuckDuckGoSearch implements SearchProvider {
    name = "duckduckgo";

    async search(query: string, maxResults = 10, timeoutMs = 10000): Promise<SearchResult[]> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const res = await fetch(url, {
                headers: { "User-Agent": "aggregate/1.0" },
                signal: controller.signal,
            });
            if (!res.ok) return [];
            const html = await res.text();
            const parsed = parseDuckDuckGoHtml(html);
            return parsed.slice(0, Math.max(1, maxResults));
        } catch {
            return [];
        } finally {
            clearTimeout(id);
        }
    }
}
