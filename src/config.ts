import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import TOML from "@iarna/toml";

const DEFAULT_CONFIG_FILE = resolve(import.meta.dir, "../config.toml");

function getConfigFilePath(): string {
    return process.env.OPOCLAW_CONFIG_PATH || DEFAULT_CONFIG_FILE;
}

// ── TOML parsing/serialization ──────────────────────────────────────────────

export function parseTOML(text: string): Record<string, any> {
    return TOML.parse(text) as Record<string, any>;
}

export function toTOML(config: Record<string, any>): string {
    return TOML.stringify(config as TOML.JsonMap);
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
        openrouter?: {
            api_key?: string;
            model?: string;
            base_url?: string;
            vision?: boolean;
            video?: boolean;
            use_session_ids?: boolean;
            // ── orproxy options (require use_proxy) ──
            use_proxy?: boolean;
            proxy_port?: number;
            quantization?: "int4" | "int8" | "fp4" | "fp6" | "fp8" | "fp16" | "bf16" | "fp32";
            reasoning_effort?: string;
            zdr?: boolean;
            strict?: boolean;
            cache?: "off" | "5m" | "1h";
            service_tier?: string;
            providers?: string[];
        };
        ollama?: { base_url?: string; model?: string };
        custom?: {
            base_url?: string;
            api_key?: string;
            model?: string;
            api_type?: "openai" | "anthropic";
            anthropic_version?: string;
            max_tokens?: number;
            vision?: boolean;
            video?: boolean;
        };
    };
    channel?: {
        discord?: {
            enabled?: boolean;
            token?: string;
            allow_bots?: boolean;
            notify_channel?: string;
        };
        signal?: {
            enabled?: boolean;
            account?: string;
            socket?: string;
            host?: string;
            port?: number;
            bot_name?: string;
            attachments_dir?: string;
            autostart?: boolean;
            signal_cli_path?: string;
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
        openai?: {
            enabled?: boolean;
            host?: string;
            port?: number;
            api_key?: string;
        };
    };
    enable_reasoning?: boolean;
    reasoning_summary?: boolean;
    reasoning_summary_model?: string;
    basic_tools?: boolean;
    real_shell?: boolean;
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
    show_update_notification?: boolean;
    heartbeat?: {
        enabled?: boolean;
        interval_minutes?: number;
    };
    cron?: {
        enabled?: boolean;
        max_jobs?: number;
        timezone?: string;
        catch_up?: boolean;
    };
    jobs?: {
        max_concurrent?: number;
        max_per_session?: number;
    };
    artifacts?: {
        retention_days?: number;
        max_bytes?: number;
    };
    usage_alerts?: {
        enabled?: boolean;
        thresholds?: number[];
        hard_limit?: number;
        session_limit?: number;
        job_limit?: number;
    };
    tools?: {
        legacy_full_exposure?: boolean;
        deno_enabled?: boolean;
        deno_timeout_ms?: number;
        deno_allowed_imports?: string[];
    };
    activity?: {
        enabled?: boolean;
        token?: string;
    };
    dreamer?: {
        enabled?: boolean;
    };
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
    // When the orproxy is enabled, route OpenRouter traffic through the local
    // proxy. The proxy mounts routes at `/:loc/chat/completions` (loc = "v1"),
    // so it expects the base without an `/api` segment.
    if (config.provider?.openrouter?.use_proxy) {
        const port = config.provider?.openrouter?.proxy_port || 3001;
        return `http://127.0.0.1:${port}`;
    }
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

export function getVideoEnabled(config: OpoclawConfig): boolean {
    const active = getActiveProvider(config);
    if (active === "custom") return config.provider?.custom?.video ?? false;
    if (active === "ollama") return false;
    return config.provider?.openrouter?.video ?? false;
}

export function getRealShellEnabled(config: OpoclawConfig): boolean {
    return config.real_shell ?? false;
}

export function getExposedCommands(config: OpoclawConfig): string[] {
    return config.exposed_commands || [];
}
