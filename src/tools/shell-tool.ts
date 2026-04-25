import path from "path";
import { exec } from "child_process";
import { mkdir, readdir, readFile, writeFile, rm, stat as fsStat } from "fs/promises";
import { Ollama } from "ollama";
import { WasmShell } from "wasm-shell";
import { WORKSPACE_DIR } from "../workspace.ts";
import { getExposedCommands, getSemanticSearchEnabled } from "../config.ts";
import { defineTool, type ToolDefinition } from "./types.ts";
import type { OpoclawConfig } from "../config.ts";

const CACHE_DIR = path.resolve(import.meta.dir, "../../cache/embeddings");
const SIMILARITY_THRESHOLD = 0.65;

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i]!, 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
}

async function hashString(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

interface LineCache {
    text: string;
    hash: string;
    embedding: number[];
}

interface FileCache {
    fileHash: string;
    lines: LineCache[];
}

async function getOllamaEmbedding(ollama: Ollama, model: string, text: string): Promise<number[]> {
    const response = await ollama.embed({ model, input: text });
    return response.embeddings[0]!;
}

async function getCachedFileEmbeddings(
    relPath: string,
    content: string,
    ollama: Ollama,
    embedModel: string,
): Promise<LineCache[]> {
    const safeName = relPath.replace(/[/\\]/g, "__");
    const cacheFile = path.join(CACHE_DIR, safeName + ".json");
    const fileHash = await hashString(content);

    let existing: FileCache | null = null;
    try {
        const raw = await readFile(cacheFile, "utf-8");
        existing = JSON.parse(raw) as FileCache;
    } catch {
    }

    if (existing?.fileHash === fileHash) {
        return existing.lines;
    }

    const existingByHash = new Map<string, number[]>();
    if (existing) {
        for (const line of existing.lines) {
            if (line.hash && line.embedding.length) {
                existingByHash.set(line.hash, line.embedding);
            }
        }
    }

    const rawLines = content.split("\n");
    const newLines: LineCache[] = [];

    for (const lineText of rawLines) {
        const trimmed = lineText.trim();
        if (!trimmed) {
            newLines.push({ text: lineText, hash: "", embedding: [] });
            continue;
        }
        const lineHash = await hashString(trimmed);
        const cached = existingByHash.get(lineHash);
        if (cached) {
            newLines.push({ text: lineText, hash: lineHash, embedding: cached });
        } else {
            const embedding = await getOllamaEmbedding(ollama, embedModel, trimmed);
            newLines.push({ text: lineText, hash: lineHash, embedding });
        }
    }

    const newCache: FileCache = { fileHash, lines: newLines };
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(newCache));
    return newLines;
}

async function semanticSearch(query: string, config: OpoclawConfig): Promise<string[]> {
    const ollamaBaseUrl = config.provider?.ollama?.base_url ?? "http://localhost:11434";
    const embedModel = "nomic-embed-text";
    const ollama = new Ollama({ host: ollamaBaseUrl });

    const glob = new Bun.Glob("**/*");
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: WORKSPACE_DIR, onlyFiles: true })) {
        files.push(file);
    }

    const queryEmbedding = await getOllamaEmbedding(ollama, embedModel, query);
    const results: { similarity: number; line: string; file: string }[] = [];

    for (const relPath of files) {
        let content: string;
        try {
            content = await readFile(path.join(WORKSPACE_DIR, relPath), "utf-8");
        } catch {
            continue;
        }
        const lines = await getCachedFileEmbeddings(relPath, content, ollama, embedModel);
        for (const line of lines) {
            if (!line.embedding.length) continue;
            const sim = cosineSimilarity(queryEmbedding, line.embedding);
            if (sim >= SIMILARITY_THRESHOLD) {
                results.push({ similarity: sim, line: line.text, file: relPath });
            }
        }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.map((result) => `[${result.file}] ${result.line.trim()} (score: ${result.similarity.toFixed(3)})`);
}

const wasmShell = new WasmShell();
const toReal = (rel: string) => path.join(WORKSPACE_DIR, rel);

wasmShell.mount("/home/", {
    async read(targetPath) {
        return readFile(toReal(targetPath));
    },
    async write(targetPath, data) {
        const full = toReal(targetPath);
        await mkdir(full.substring(0, full.lastIndexOf("/")), { recursive: true });
        await writeFile(full, data);
    },
    async list(targetPath) {
        const entries = await readdir(toReal(targetPath), { withFileTypes: true });
        return entries.map((entry) => entry.name);
    },
    async stat(targetPath) {
        const stats = await fsStat(toReal(targetPath));
        return { isFile: stats.isFile(), isDir: stats.isDirectory(), isDevice: false, size: stats.size };
    },
    async remove(targetPath) {
        await rm(toReal(targetPath), { recursive: true, force: true });
    },
});

wasmShell.setEnv("HOME", "/home");
wasmShell.setCwd("/home");

let shellSetUp = false;

const dec = new TextDecoder();
const enc = new TextEncoder();

async function ensureShellTools(config: OpoclawConfig): Promise<void> {
    if (shellSetUp) return;
    shellSetUp = true;

    if (getSemanticSearchEnabled(config)) {
        wasmShell.addProgram("semantic-search", async (ctx) => {
            const query = ctx.args.slice(1).join(" ").trim();
            if (!query || query === "--help") {
                await ctx.writeStderr(enc.encode("Usage: semantic-search <query>\n"));
                return 1;
            }
            const searchResults = await semanticSearch(query, config);
            const output = searchResults.length > 0
                ? searchResults.join("\n") + "\n"
                : "(no results)\n";
            await ctx.writeStdout(enc.encode(output));
            return 0;
        });
    }

    for (const command of getExposedCommands(config)) {
        wasmShell.addProgram(command, async (ctx) => {
            const args = ctx.args.slice(1);
            return await new Promise<number>((resolve) => {
                exec(`${command} ${args.join(" ")}`, (error, stdout, stderr) => {
                    if (stderr.trim().length > 0) {
                        ctx.writeStderr(enc.encode(stderr.trim() + "\n"));
                    }
                    if (stdout.trim().length > 0) {
                        ctx.writeStdout(enc.encode(stdout.trim() + "\n"));
                    }
                    resolve(error ? 1 : 0);
                });
            });
        });
    }
}

export const SHELL_TOOLS = {
    shell: defineTool(
        "shell",
        "Run a shell command. This is in a sandboxed environment with a bash-like shell. `~` is your workspace, and is the default working directory. You've got all the commands you'd expect, like `grep`, `cat`, `sed`, and so on. However, you don't have access to Python or other runtimes. Treat this as a way to interact with the workspace and files. You can use `grep -ri 'some text'` to search for text recursively from the working directory.",
        {
            description: {
                type: "string",
                description: "User-facing description of what you're doing. Like: \"Searching through memory files\", \"Writing to MEMORY.md\", and so on. Don't add an elipsis at the end. Keep this concise.",
            },
            shell_command: {
                type: "string",
                description: "The shell command to run.",
            },
        },
        ["description", "shell_command"],
        {
            handler: async (args, { config }) => {
                if (!args.shell_command) throw new Error("Missing 'shell_command' argument for shell.");
                await ensureShellTools(config);
                const result = await wasmShell.exec(String(args.shell_command));
                let output = "";

                if (result.stdout) output += `stdout:\n\`\`\`${dec.decode(result.stdout).trim()}\`\`\`\n`;
                if (result.stderr) output += `stderr:\n\`\`\`${dec.decode(result.stderr).trim()}\`\`\`\n`;
                if (output.length === 0) output = "(no shell output)";
                if (result.code !== 0) output = `Command exited with code ${result.code}.\n${output}`;

                const home = wasmShell.getEnv("HOME") ?? "/home";
                const cwd = wasmShell.getCwd();
                const display = cwd === home ? "~" : cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
                return `${output.trim()}\n(Current directory: ${display})`;
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
