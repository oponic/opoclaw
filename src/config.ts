import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

const CONFIG_FILE = resolve(import.meta.dir, "../config.toml");

// ── Minimal TOML parser (for our config format) ────────────────────────────

export function parseTOML(text: string): Record<string, any> {
    const result: Record<string, any> = {};
    const lines = text.split("\n");
    let currentSection: Record<string, any> = result;
    let currentKey = "";

    for (const raw of lines) {
        const line = raw.replace(/#.*$/, "").trim();
        if (!line) continue;

        // Section header: [key]
        const sectionMatch = line.match(/^\[(\w+)\]$/);
        if (sectionMatch) {
            currentKey = sectionMatch[1];
            result[currentKey] = result[currentKey] || {};
            currentSection = result[currentKey];
            continue;
        }

        // Key = value
        const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
        if (kvMatch) {
            const [, key, rawValue] = kvMatch;
            let value: any = rawValue.trim();

            // String
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
            // Boolean
            else if (value === "true") value = true;
            else if (value === "false") value = false;
            // Number
            else if (/^-?\d+$/.test(value)) value = parseInt(value, 10);
            else if (/^-?\d+\.\d+$/.test(value)) value = parseFloat(value);

            currentSection[key] = value;
        }
    }

    return result;
}

export function toTOML(config: Record<string, any>): string {
    let out = "";
    const simple: Record<string, any> = {};
    const sections: Record<string, Record<string, any>> = {};

    for (const [key, value] of Object.entries(config)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            sections[key] = value;
        } else {
            simple[key] = value;
        }
    }

    // Simple keys first
    for (const [key, value] of Object.entries(simple)) {
        out += `${key} = ${formatTOMLValue(value)}\n`;
    }

    // Sections
    for (const [section, values] of Object.entries(sections)) {
        out += `\n[${section}]\n`;
        for (const [key, value] of Object.entries(values)) {
            out += `${key} = ${formatTOMLValue(value)}\n`;
        }
    }

    return out;
}

export function formatTOMLValue(value: any): string {
    if (typeof value === "string") return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    return `"${String(value)}"`;
}

// ── Config interface ───────────────────────────────────────────────────────

export interface OpoclawConfig {
    discordToken: string;
    openrouterKey?: string;
    openrouterModel?: string;
    // Ollama (local models)
    provider?: "openrouter" | "ollama";
    ollamaBaseURL?: string;
    ollamaModel?: string;
    // General
    allowBots?: boolean;
    enableReasoning?: boolean;
    reasoningSummary?: boolean;
    reasoningSummaryModel?: string;
    notifyChannel?: string;
}

export function loadConfig(): OpoclawConfig {
    if (!existsSync(CONFIG_FILE)) {
        throw new Error(`config.toml not found at ${CONFIG_FILE}`);
    }
    const text = readFileSync(CONFIG_FILE, "utf-8");
    return parseTOML(text) as unknown as OpoclawConfig;
}

export function getConfigPath(): string {
    return CONFIG_FILE;
}

export function getApiBaseUrl(config: OpoclawConfig): string {
    if (config.provider === "ollama") {
        return config.ollamaBaseURL || "http://localhost:11434";
    }
    return "https://openrouter.ai";
}

export function getApiKey(config: OpoclawConfig): string {
    if (config.provider === "ollama") {
        return config.ollamaBaseURL || "ollama"; // Ollama doesn't need a real key
    }
    return config.openrouterKey || "";
}

export function getModelId(config: OpoclawConfig): string {
    if (config.provider === "ollama") {
        return config.ollamaModel || "llama3.2";
    }
    return config.openrouterModel || "openrouter/auto";
}
