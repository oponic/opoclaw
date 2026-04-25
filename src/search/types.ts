export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    source: string;
}

export interface SearchProvider {
    name: string;
    search(query: string, maxResults?: number, timeoutMs?: number): Promise<SearchResult[]>;
}
