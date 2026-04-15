import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { TOOLS } from "./tools";

const DEFAULT_CONFIG_FILE = resolve(import.meta.dir, "../config.toml");

function getConfigFilePath(): string {
    return process.env.OPOCLAW_CONFIG_PATH || DEFAULT_CONFIG_FILE;
}

// ── Minimal TOML parser (for our config format) ────────────────────────────

export function parseTOML(text: string): Record<string, any> {
    const result: Record<string, any> = {};
    const lines = text.split("\n");
    let currentSection: Record<string, any> = result;
    let currentKey = "";

    for (const raw of lines) {
        const line = raw.replace(/#.*$/, "").trim();
        if (!line) continue;

        // Section header: [key] or [key.subkey]
        const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
        if (sectionMatch && sectionMatch[1]) {
            currentKey = sectionMatch[1];
            const parts = currentKey.split(".").filter(Boolean);
            let cursor: Record<string, any> = result;
            for (const part of parts) {
                cursor[part] = cursor[part] || {};
                cursor = cursor[part];
            }
            currentSection = cursor;
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

    function ensureSection(name: string): Record<string, any> {
        if (!sections[name]) sections[name] = {};
        return sections[name]!;
    }

    function walk(obj: Record<string, any>, prefix = ""): void {
        for (const [key, value] of Object.entries(obj)) {
            const isObj =
                typeof value === "object" && value !== null && !Array.isArray(value);
            if (isObj) {
                const nextPrefix = prefix ? `${prefix}.${key}` : key;
                walk(value, nextPrefix);
            } else {
                if (!prefix) {
                    simple[key] = value;
                } else {
                    ensureSection(prefix)[key] = value;
                }
            }
        }
    }

    walk(config);

    // Simple keys first
    for (const [key, value] of Object.entries(simple)) {
        out += `${key} = ${formatTOMLValue(value)}\n`;
    }

    // Sections (sorted for stability)
    for (const section of Object.keys(sections).sort()) {
        const values = sections[section]!;
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
    provider?: {
        active?: "openrouter" | "ollama" | "custom";
        openrouter?: { api_key?: string; model?: string; base_url?: string; vision?: boolean };
        ollama?: { base_url?: string; model?: string };
        custom?: {
            base_url?: string;
            api_key?: string;
            model?: string;
            api_type?: "openai" | "anthropic";
            anthropic_version?: string;
            max_tokens?: number;
            vision?: boolean;
        };
    };
    channel?: {
        discord?: {
            enabled?: boolean;
            token?: string;
            allow_bots?: boolean;
            notify_channel?: string;
        };
        irc?: {
            enabled?: boolean;
            server?: string;
            port?: number;
            tls?: boolean;
            nick?: string;
            username?: string;
            realname?: string;
            password?: string;
            channels?: string;
        };
    };
    enable_reasoning?: boolean;
    reasoning_summary?: boolean;
    reasoning_summary_model?: string;
    basic_tools?: boolean;
    advanced_tools?: boolean;
    ollama_semantic_search?: boolean;
    use_toml_files?: boolean;
    authorized_user_id?: string;
    update_channel?: "stable" | "unstable";
    exposed_commands?: string[];
    enable_web_fetch?: boolean;
    less_verbose_tools?: boolean;
    mounts?: Record<string, string>;
    search_provider?: "duckduckgo" | "tavily";
    tavily_api_key?: string;
}

export function loadConfig(): OpoclawConfig {
    const configPath = getConfigFilePath();
    if (!existsSync(configPath)) {
        throw new Error(`config.toml not found at ${configPath}`);
    }
    const text = readFileSync(configPath, "utf-8");
    return parseTOML(text) as unknown as OpoclawConfig;
}

export function getConfigPath(): string {
    return getConfigFilePath();
}

export function getApiBaseUrl(config: OpoclawConfig): string {
    const active = getActiveProvider(config);
    if (active === "custom") return config.provider?.custom?.base_url || "http://localhost:11434";
    if (active === "ollama") return config.provider?.ollama?.base_url || "http://localhost:11434";
    return config.provider?.openrouter?.base_url || "https://openrouter.ai/api";
}

export function getApiKey(config: OpoclawConfig): string {
    const active = getActiveProvider(config);
    if (active === "custom") return config.provider?.custom?.api_key || "";
    if (active === "ollama") return "";
    return config.provider?.openrouter?.api_key || "";
}

export function getModelId(config: OpoclawConfig): string {
    const active = getActiveProvider(config);
    if (active === "custom") return config.provider?.custom?.model || "unknown";
    if (active === "ollama") return config.provider?.ollama?.model || "llama3.2";
    return config.provider?.openrouter?.model || "openrouter/auto";
}

export function getTools(config: OpoclawConfig): any[] {
    const tools = [
        TOOLS.send_file,
        TOOLS.search,
        TOOLS.edit_config,
        TOOLS.restart_gateway,
        TOOLS.hibernate_gateway,
        TOOLS.update_opoclaw,
        TOOLS.use_skill,
        TOOLS.list_skills,
        TOOLS.deep_research,
        TOOLS.react_message,
        TOOLS.request_permission,
        TOOLS.question,
        TOOLS.poll,
        TOOLS.shell,
    ];

    if (config.enable_web_fetch ?? true) {
        tools.push(TOOLS.web_fetch);
    }

    if (config.basic_tools ?? true) {
        tools.push(TOOLS.read_file, TOOLS.edit_file, TOOLS.list_files);
    }

    if (config.advanced_tools ?? false) {
        tools.push(TOOLS.mkdir, TOOLS.rm, TOOLS.mv, TOOLS.cp);
    }

    return tools;
}

export function getSemanticSearchEnabled(config: OpoclawConfig): boolean {
    return config.ollama_semantic_search ?? false;
}

export function useTomlFiles(config: OpoclawConfig): boolean {
    return config.use_toml_files ?? false;
}

export function getActiveProvider(config: OpoclawConfig): "openrouter" | "ollama" | "custom" {
    return config.provider?.active || "openrouter";
}

export function getVisionEnabled(config: OpoclawConfig): boolean {
    const active = getActiveProvider(config);
    if (active === "custom") return config.provider?.custom?.vision ?? false;
    if (active === "ollama") return false;
    return config.provider?.openrouter?.vision ?? false;
}

export function getExposedCommands(config: OpoclawConfig): string[] {
    return config.exposed_commands || [];
}
