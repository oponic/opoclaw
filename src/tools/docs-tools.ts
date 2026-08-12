import { resolve } from "path";
import { readFile } from "fs/promises";
import { defineTool, type ToolDefinition } from "./types.ts";

const ROOT = resolve(import.meta.dir, "../..");
const DOCS = ["README.md", "ROADMAP.md", "src/SYSTEM.md", "installers/onboard.ts", "installers/setup.sh", "installers/setup.ps1"];

async function documentationFiles(): Promise<string[]> {
    const files = [...DOCS];
    const glob = new Bun.Glob("**/*.{md,html}");
    for await (const file of glob.scan({ cwd: resolve(ROOT, "docs"), onlyFiles: true })) files.push(`docs/${file}`);
    return files;
}

export async function searchDocumentation(query: string, limit = 8): Promise<string> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new Error("query is required.");
    const matches: { file: string; line: number; text: string; score: number }[] = [];
    for (const file of await documentationFiles()) {
        let text = "";
        try { text = await readFile(resolve(ROOT, file), "utf8"); } catch { continue; }
        for (const [index, raw] of text.split("\n").entries()) {
            const line = raw.trim(); if (!line) continue;
            const lower = line.toLowerCase();
            const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
            if (score > 0) matches.push({ file, line: index + 1, text: line.slice(0, 500), score });
        }
    }
    const selected = matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line).slice(0, Math.max(1, Math.min(20, limit)));
    return selected.length ? selected.map((match) => `${match.file}:${match.line}\n${match.text}`).join("\n\n") : "(no documentation matches)";
}

export const DOCS_TOOLS = {
    search_docs: defineTool(
        "search_docs",
        "Search Opoclaw's bundled documentation and return ranked snippets with file and line references.",
        { query: { type: "string", description: "Words or phrase to search for in Opoclaw documentation." }, limit: { type: "number", description: "Maximum snippets to return (1-20, default 8)." } },
        ["query"],
        { toolset: "information", keywords: ["documentation", "docs", "help", "configuration", "opoclaw"], capabilities: ["read"], handler: async (args) => searchDocumentation(String(args.query || ""), Number(args.limit || 8)) },
    ),
} satisfies Record<string, ToolDefinition>;
