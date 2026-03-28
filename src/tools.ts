import { readFileAsync, getFilePath, editFile, listFiles, WORKSPACE_DIR } from "./workspace.ts";
import { Ollama } from "ollama";

export const TOOLS: { [id: string]: any } = {
    read_file: {
        type: "function",
        function: {
            name: "read_file",
            description:
                "Read the contents of a file in the workspace. Only files in the workspace directory can be read.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace (e.g. 'AGENTS.md').",
                    },
                },
                required: ["path"],
            },
        },
    },
    edit_file: {
        type: "function",
        function: {
            name: "edit_file",
            description:
                "Overwrite the contents of an existing file in the workspace. You cannot create new files or delete files — only edit files that already exist.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace.",
                    },
                    content: {
                        type: "string",
                        description: "The new complete content to write to the file.",
                    },
                },
                required: ["path", "content"],
            },
        },
    },
    list_files: {
        type: "function",
        function: {
            name: "list_files",
            description: "List all files currently in the workspace directory.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    send_file: {
        type: "function",
        function: {
            name: "send_file",
            description:
                "Send a file from the workspace as a Discord attachment. The file will be sent after the agent's response.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace.",
                    },
                    caption: {
                        type: "string",
                        description: "Optional caption for the file.",
                    },
                },
                required: ["path"],
            },
        },
    },
    edit_config: {
        type: "function",
        function: {
            name: "edit_config",
            description:
                "Update a single key in config.toml at the project root. This is restricted and requires user approval.",
            parameters: {
                type: "object",
                properties: {
                    key: {
                        type: "string",
                        description: "Config key to update. Use dot notation for sections (e.g. 'provider.ollama.base_url').",
                    },
                    value: {
                        type: "string",
                        description: "New value for the key.",
                    },
                },
                required: ["key", "value"],
            },
        },
    },
    restart_gateway: {
        type: "function",
        function: {
            name: "restart_gateway",
            description:
                "Restart the opoclaw gateway. This is restricted and requires user approval.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    hibernate_gateway: {
        type: "function",
        function: {
            name: "hibernate_gateway",
            description:
                "Hibernate the opoclaw gateway (stop responses until approved to wake). This is restricted and requires user approval.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    update_opoclaw: {
        type: "function",
        function: {
            name: "update_opoclaw",
            description:
                "Update opoclaw to the latest version. This is restricted and requires user approval.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    search: {
        type: "function",
        function: {
            name: "search",
            description:
                "Search the web using DuckDuckGo (no API key required) and return top results.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search query.",
                    },
                    count: {
                        type: "number",
                        description: "Max results to return (1-10). Defaults to 5.",
                    },
                },
                required: ["query"],
            },
        },
    },
    use_skill: {
        type: "function",
        function: {
            name: "use_skill",
            description:
                "Load a skill by name from workspace/skills/<skill>/SKILL.md. Use this before applying a skill's instructions.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Skill folder name under workspace/skills.",
                    },
                },
                required: ["name"],
            },
        },
    },
    list_skills: {
        type: "function",
        function: {
            name: "list_skills",
            description: "List available skills from workspace/skills.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    deep_research: {
        type: "function",
        function: {
            name: "deep_research",
            description:
                "Enable Deep Research mode to perform multi-step research and return synthesized markdown documents.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Research query or question.",
                    },
                },
                required: ["query"],
            },
        },
    },
    web_fetch: {
        type: "function",
        function: {
            name: "web_fetch",
            description: "Fetch a web page and return its text content.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "The URL to fetch.",
                    },
                },
                required: ["url"],
            },
        },
    },
    shell: {
        type: "function",
        function: {
            name: "shell",
            description:
                "Run a shell command. This is in a sandboxed environment with a bash-like shell. `~` is your workspace, and is the default working directory. You've got all the commands you'd expect, like `grep`, `cat`, `sed`, and so on. However, you don't have access to Python or other runtimes. Treat this as a way to interact with the workspace and files. You can use `grep -ri 'some text'` to search for text recursively from the working directory.",
            parameters: {
                type: "object",
                properties: {
                    description: {
                        type: "string",
                        description: "User-facing description of what you're doing. Like: \"Searching through memory files\", \"Writing to MEMORY.md\", and so on. Don't add an elipsis at the end. Keep this concise.",
                    },
                    shell_command: {
                        type: "string",
                        description: "The shell command to run.",
                    },
                },
                required: ["description", "shell_command"],
            },
        },
    }
} as const;

const CACHE_DIR = path.resolve(import.meta.dir, "../cache/embeddings");
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
        .map(b => b.toString(16).padStart(2, "0"))
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
    // Cache file path: flat, safe name derived from the relative path
    const safeName = relPath.replace(/[/\\]/g, "__");
    const cacheFile = path.join(CACHE_DIR, safeName + ".json");
    const fileHash = await hashString(content);

    let existing: FileCache | null = null;
    try {
        const raw = await readFile(cacheFile, "utf-8");
        existing = JSON.parse(raw) as FileCache;
    } catch {
        // not cached yet or unreadable
    }

    if (existing?.fileHash === fileHash) {
        return existing.lines;
    }

    // Build lookup of already-embedded lines by their hash to avoid re-embedding unchanged lines
    const existingByHash = new Map<string, number[]>();
    if (existing) {
        for (const l of existing.lines) {
            if (l.hash && l.embedding.length) {
                existingByHash.set(l.hash, l.embedding);
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

    // Gather all workspace files
    const glob = new Bun.Glob("**/*");
    const files: string[] = [];
    for await (const f of glob.scan({ cwd: WORKSPACE_DIR, onlyFiles: true })) {
        files.push(f);
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
        for (const l of lines) {
            if (!l.embedding.length) continue;
            const sim = cosineSimilarity(queryEmbedding, l.embedding);
            if (sim >= SIMILARITY_THRESHOLD) {
                results.push({ similarity: sim, line: l.text, file: relPath });
            }
        }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.map(r => `[${r.file}] ${r.line.trim()} (score: ${r.similarity.toFixed(3)})`);
}

// Track pending file sends (picked up by index.ts after tool execution)
export let pendingFileSend: { path: string; caption: string } | null = null;

export function clearPendingFileSend(): void {
    pendingFileSend = null;
}

import { WasmShell } from "wasm-shell";
const shell = new WasmShell();

import path from "path";
import { mkdir, readdir, readFile, writeFile, rm, stat as fsStat } from "fs/promises";
import { getConfigPath, getExposedCommands, getSemanticSearchEnabled, parseTOML, toTOML, type OpoclawConfig } from "./config.ts";
import { listSkills, readSkill } from "./skills.ts";
import { DuckDuckGoSearch } from "./search/duckduckgo.ts";
const toReal = (rel: string) => path.join(WORKSPACE_DIR, rel);

shell.mount("/home/", {
    async read(path) {
        return readFile(toReal(path));
    },
    async write(path, data) {
        const full = toReal(path);
        await mkdir(full.substring(0, full.lastIndexOf("/")), { recursive: true });
        await writeFile(full, data);
    },
    async list(path) {
        const entries = await readdir(toReal(path), { withFileTypes: true });
        return entries.map(e => e.name);
    },
    async stat(path) {
        const s = await fsStat(toReal(path));
        return { isFile: s.isFile(), isDir: s.isDirectory(), isDevice: false, size: s.size };
    },
    async remove(path) {
        await rm(toReal(path), { recursive: true, force: true });
    },
});

shell.setEnv("HOME", "/home");
shell.setCwd("/home");

let shellSetUp = false;

const dec = new TextDecoder();

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

async function duckDuckGoSearch(query: string, count = 5): Promise<string> {
    const provider = new DuckDuckGoSearch();
    const results = await provider.search(query, count);
    if (!results.length) return "(no results)";
    return results
        .slice(0, count)
        .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`.trim())
        .join("\n\n");
}

async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            headers: { "User-Agent": "opoclaw-bot/1.0" },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(id);
    }
}

async function searxSearch(query: string, count = 5): Promise<string> {
    const instances = [
        "https://searx.be",
        "https://searx.tiekoetter.com",
        "https://search.projectsegfau.lt",
    ];

    for (const base of instances) {
        try {
            const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
            const res = await fetchWithTimeout(url, 6000);
            if (!res.ok) continue;
            const data: any = await res.json();
            const results = Array.isArray(data?.results) ? data.results : [];
            const mapped = results
                .filter((r: any) => r?.url && r?.title)
                .slice(0, count)
                .map((r: any, i: number) => `${i + 1}. ${r.title}\n${r.url}\n${r.content || ""}`.trim());
            if (mapped.length > 0) {
                return mapped.join("\n\n");
            }
        } catch {
            continue;
        }
    }
    return "(no results)";
}


function setNestedValue(obj: Record<string, any>, keyPath: string, value: any): void {
    const parts = keyPath.split(".").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) {
        throw new Error("Invalid key path.");
    }
    let cur: Record<string, any> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        if (typeof cur[part] !== "object" || cur[part] === null || Array.isArray(cur[part])) {
            cur[part] = {};
        }
        cur = cur[part] as Record<string, any>;
    }
    cur[parts[parts.length - 1]!] = value;
}

function coerceConfigValue(raw: string): any {
    const trimmed = raw.trim();
    if (
        (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
    return raw;
}

import { exec } from "child_process";

const enc = new TextEncoder();

export async function handleToolCall(
    name: string,
    args: Record<string, string>,
    config: OpoclawConfig,
): Promise<string> {
    console.log(`Handling tool call: ${name} with args ${JSON.stringify(args)}`);
    switch (name) {
        case "read_file": {
            if (!args.path) throw new Error("Missing 'path' argument for read_file.");
            const content = await readFileAsync(args.path);
            return content;
        }
        case "edit_file": {
            if (!args.path) throw new Error("Missing 'path' argument for edit_file.");
            if (args.content === undefined)
                throw new Error("Missing 'content' argument for edit_file.");
            await editFile(args.path, args.content);
            return `Successfully wrote ${args.content.length} characters to "${args.path}".`;
        }
        case "list_files": {
            const files = await listFiles();
            return files.length > 0
                ? files.map((f) => `• ${f}`).join("\n")
                : "(workspace is empty)";
        }
        case "send_file": {
            if (!args.path) throw new Error("Missing 'path' argument for send_file.");
            // Validate file exists
            getFilePath(args.path);
            // Queue file for sending after response
            pendingFileSend = { path: args.path, caption: args.caption || "" };
            return `File "${args.path}" queued for sending.`;
        }
        case "edit_config": {
            if (!args.key) throw new Error("Missing 'key' argument for edit_config.");
            if (args.value === undefined) throw new Error("Missing 'value' argument for edit_config.");
            const configPath = getConfigPath();
            const raw = await readFile(configPath, "utf-8");
            const parsed = parseTOML(raw);
            const nextValue = coerceConfigValue(String(args.value));
            setNestedValue(parsed, String(args.key), nextValue);
            const next = toTOML(parsed);
            await writeFile(configPath, next, "utf-8");
            return `Updated config key "${args.key}".`;
        }
        case "restart_gateway": {
            const cmd = ["bash", "-lc", "sleep 1; bun run src/cli.ts gateway restart"];
            const proc = Bun.spawn({
                cmd,
                cwd: path.resolve(import.meta.dir, ".."),
                stdout: "ignore",
                stderr: "ignore",
                detached: true,
            });
            if (typeof (proc as any).unref === "function") {
                (proc as any).unref();
            }
            return "Gateway restart initiated.";
        }
        case "hibernate_gateway": {
            const hibernatePath = path.resolve(import.meta.dir, "..", ".gateway.hibernate");
            await writeFile(hibernatePath, new Date().toISOString(), "utf-8");
            return "Gateway hibernation enabled.";
        }
        case "update_opoclaw": {
            const cmd = ["bash", "-lc", "sleep 1; bun run src/cli.ts update"];
            const proc = Bun.spawn({
                cmd,
                cwd: path.resolve(import.meta.dir, ".."),
                stdout: "ignore",
                stderr: "ignore",
                detached: true,
            });
            if (typeof (proc as any).unref === "function") {
                (proc as any).unref();
            }
            return "Update initiated.";
        }
        case "search": {
            if (!args.query) throw new Error("Missing 'query' argument for search.");
            const countRaw = Number(args.count ?? 5);
            const count = Number.isFinite(countRaw) ? Math.min(Math.max(1, countRaw), 10) : 5;
            const q = String(args.query);
            return await duckDuckGoSearch(q, count);
        }
        case "use_skill": {
            if (!args.name) throw new Error("Missing 'name' argument for use_skill.");
            return await readSkill(String(args.name));
        }
        case "list_skills": {
            const skills = await listSkills();
            return skills.length > 0 ? skills.join("\n") : "(no skills)";
        }
        case "web_fetch": {
            if (!args.url) throw new Error("Missing 'url' argument for web_fetch.");
            const res = await fetch(String(args.url), { headers: { "User-Agent": "opoclaw-bot/1.0" } });
            if (!res.ok) throw new Error(`web_fetch failed (${res.status})`);
            const text = await res.text();
            return text;
        }
        case "shell": {
            if (!shellSetUp) {
                shellSetUp = true;
                if (getSemanticSearchEnabled(config)) {
                    shell.addProgram('semantic-search', async (ctx) => {
                        const query = ctx.args.slice(1).join(' ').trim();
                        if (!query || query === '--help') {
                            await ctx.writeStderr(enc.encode('Usage: semantic-search <query>\n'));
                            return 1;
                        }
                        const searchResults = await semanticSearch(query, config);
                        const out = searchResults.length > 0
                            ? searchResults.join('\n') + '\n'
                            : '(no results)\n';
                        await ctx.writeStdout(enc.encode(out));
                        return 0;
                    });
                }

                const commands = getExposedCommands(config);
                for (const cmd of commands) {
                    shell.addProgram(cmd, async (ctx) => {
                        const args = ctx.args.slice(1);
                        // run that with `exec`
                        return new Promise((resolve) => {
                            const c = `${cmd} ${args.join(" ")}`;
                            exec(c, (error, stdout, stderr) => {
                                if (stderr.trim().length > 0) {
                                    ctx.writeStderr(enc.encode(stderr.trim() + "\n"));
                                }
                                if (stdout.trim().length > 0) {
                                    ctx.writeStdout(enc.encode(stdout.trim() + "\n"));
                                }
                                resolve(0);
                            });
                        });
                    });
                }
            }
            if (!args.shell_command) throw new Error("Missing 'shell_command' argument for shell.");
            const result = await shell.exec(args.shell_command);
            let output = "";
            
            if (result.stdout) output += `stdout:\n\`\`\`${dec.decode(result.stdout).trim()}\`\`\`\n`;
            if (result.stderr) output += `stderr:\n\`\`\`${dec.decode(result.stderr).trim()}\`\`\`\n`;
            if (output.length === 0) output = "(no shell output)";
            if (result.code !== 0) output = `Command exited with code ${result.code}.\n` + output;
            const home = shell.getEnv("HOME") ?? "/home";
            const cwd = shell.getCwd();
            const display = cwd === home
                ? "~"
                : cwd.startsWith(home + "/")
                    ? "~" + cwd.slice(home.length)
                    : cwd;
            return output.trim() + `\n(Current directory: ${display})`;
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
