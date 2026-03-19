import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { TOOLS } from "./tools";

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
        if (sectionMatch && sectionMatch[1]) {
            currentKey = sectionMatch[1];
            result[currentKey] = result[currentKey] || {};
            currentSection = result[currentKey];
            continue;
        }

        // Key = value
        const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
        if (kvMatch && kvMatch[1] && kvMatch[2]) {
            const key = kvMatch[1];
            const rawValue = kvMatch[2];
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

            currentSection[key!] = value;
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
    discord_token: string;
    openrouter_key: string;
    openrouter_model: string;
    provider?: "openrouter" | "ollama" | "custom";
    ollama?: { base_url?: string; model?: string };
    custom?: {
        base_url?: string;
        api_key?: string;
        model?: string;
        api_type?: "openai" | "anthropic";
        anthropic_version?: string;
        max_tokens?: number;
    };
    allow_bots?: boolean;
    enable_reasoning?: boolean;
    reasoning_summary?: boolean;
    reasoning_summary_model?: string;
    notify_channel?: string;
    basic_tools?: boolean;
    ollama_semantic_search?: boolean;
    use_toml_files?: boolean;
    authorized_user_id?: string;
    exposed_commands?: string[];
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
    if (config.provider === "custom") return config.custom?.base_url || "http://localhost:11434";
    if (config.provider === "ollama") return config.ollama?.base_url || "http://localhost:11434";
    return "https://openrouter.ai/api";
}

export function getApiKey(config: OpoclawConfig): string {
    if (config.provider === "custom") return config.custom?.api_key || "";
    if (config.provider === "ollama") return "";
    return config.openrouter_key || "";
}

export function getModelId(config: OpoclawConfig): string {
    if (config.provider === "custom") return config.custom?.model || "unknown";
    if (config.provider === "ollama") return config.ollama?.model || "llama3.2";
    return config.openrouter_model || "openrouter/auto";
}

export function getTools(config: OpoclawConfig): any[] {
    const tools = [
        TOOLS.send_file,
        TOOLS.search,
        TOOLS.edit_config,
        TOOLS.restart_gateway,
        TOOLS.hibernate_gateway,
        TOOLS.update_opoclaw,
        TOOLS.shell,
    ];

    if (config.basic_tools ?? true) {
        tools.push(TOOLS.read_file, TOOLS.edit_file, TOOLS.list_files);
    }

    return tools;
}

export function getSemanticSearchEnabled(config: OpoclawConfig): boolean {
    return config.ollama_semantic_search ?? false;
}

export function useTomlFiles(config: OpoclawConfig): boolean {
    return config.use_toml_files ?? false;
}

export function getExposedCommands(config: OpoclawConfig): string[] {
    return config.exposed_commands || [];
}
