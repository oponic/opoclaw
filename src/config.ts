import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { TOOLS, listPluginToolDescriptors } from "./tools";
import * as toml from "@iarna/toml";

const DEFAULT_CONFIG_FILE = resolve(import.meta.dir, "../config.toml");
const DEFAULT_PROVIDER = "openrouter";
const BASE_TOOLS = [
    "send_file",
    "search",
    "edit_config",
    "restart_gateway",
    "hibernate_gateway",
    "update_opoclaw",
    "use_skill",
    "list_skills",
    "deep_research",
    "react_message",
    "request_permission",
    "question",
    "poll",
    "shell",
] as const;
const BASIC_TOOL_IDS = ["read_file", "edit_file", "list_files"] as const;
const ADVANCED_TOOL_IDS = ["mkdir", "rm", "mv", "cp"] as const;

function getConfigFilePath(): string {
    return process.env.OPOCLAW_CONFIG_PATH || DEFAULT_CONFIG_FILE;
}

export function parseTOML(text: string): Record<string, any> {
    return toml.parse(text) as Record<string, any>;
}

export function toTOML(config: Record<string, any>): string {
    return toml.stringify(config);
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
    tool_call_summaries?: "full" | "minimal" | "off";
    mounts?: Record<string, string>;
    search_provider?: "duckduckgo" | "tavily";
    tavily_api_key?: string;
    actual_shell?: boolean;
    // Plugin settings (tool-only worker runtime)
    enable_plugins?: boolean;
    plugin_dir?: string;
    show_update_notification?: boolean;
}

export function loadConfig(): OpoclawConfig {
    const configPath = getConfigFilePath();
    if (!existsSync(configPath)) {
        throw new Error(`config.toml not found at ${configPath}`);
    }
    const text = readFileSync(configPath, "utf-8");
    const parsed = parseTOML(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid config at ${configPath}`);
    }
    return parsed as OpoclawConfig;
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
    const toolIds = new Set<string>(BASE_TOOLS as readonly string[]);

    if (config.enable_web_fetch ?? true) {
        toolIds.add("web_fetch");
    }

    if (config.basic_tools ?? true) {
        for (const toolId of BASIC_TOOL_IDS) {
            toolIds.add(toolId);
        }
    }

    if (config.advanced_tools ?? false) {
        for (const toolId of ADVANCED_TOOL_IDS) {
            toolIds.add(toolId);
        }
    }

    const tools = Array.from(toolIds)
        .map((toolId) => TOOLS[toolId])
        .filter(Boolean);

    if (pluginsEnabled(config)) {
        const pluginTools = listPluginToolDescriptors();
        for (const pluginTool of pluginTools) {
            const pluginToolName = pluginTool?.function?.name;
            if (typeof pluginToolName !== "string" || !pluginToolName) continue;
            const exists = tools.some((tool) => tool?.function?.name === pluginToolName);
            if (!exists) {
                tools.push(pluginTool);
            }
        }
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
    return config.provider?.active || DEFAULT_PROVIDER;
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

export function pluginsEnabled(config: OpoclawConfig): boolean {
    return config.enable_plugins ?? false;
}

export function getPluginDir(config: OpoclawConfig): string {
    // If config provides plugin_dir use it, otherwise default to workspace/plugins relative to repo
    return config.plugin_dir || resolve(import.meta.dir, "../workspace/plugins");
}
