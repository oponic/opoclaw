import { existsSync, statSync } from "fs";
import { getConfigPath, type OpoclawConfig } from "./config.ts";

export type ConfigIssue = { path: string; message: string };

export function validateConfig(config: OpoclawConfig): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    const active = config.provider?.active;
    if (active === "openrouter" && !config.provider?.openrouter?.api_key) issues.push({ path: "provider.openrouter.api_key", message: "Required when OpenRouter is active." });
    if (active === "custom" && !config.provider?.custom?.base_url) issues.push({ path: "provider.custom.base_url", message: "Required when custom provider is active." });
    if (config.channel?.discord?.enabled && !config.channel.discord.token) issues.push({ path: "channel.discord.token", message: "Required when Discord is enabled." });
    if (config.channel?.signal?.enabled && !config.channel.signal.account) issues.push({ path: "channel.signal.account", message: "Required when Signal is enabled." });
    if (config.cron?.max_jobs !== undefined && (!Number.isInteger(config.cron.max_jobs) || config.cron.max_jobs < 1)) issues.push({ path: "cron.max_jobs", message: "Must be a positive integer." });
    for (const [key, value] of Object.entries({ max_concurrent: config.jobs?.max_concurrent, max_per_session: config.jobs?.max_per_session })) {
        if (value !== undefined && (!Number.isInteger(value) || value < 1)) issues.push({ path: `jobs.${key}`, message: "Must be a positive integer." });
    }
    if (config.cron?.timezone !== undefined) { try { Intl.DateTimeFormat(undefined, { timeZone: config.cron.timezone }); } catch { issues.push({ path: "cron.timezone", message: "Must be a valid IANA timezone." }); } }
    for (const threshold of config.usage_alerts?.thresholds || []) if (!Number.isFinite(threshold) || threshold < 0) issues.push({ path: "usage_alerts.thresholds", message: "Thresholds must be non-negative numbers." });
    for (const [key, value] of Object.entries({ hard_limit: config.usage_alerts?.hard_limit, session_limit: config.usage_alerts?.session_limit })) if (value !== undefined && (!Number.isFinite(value) || value < 0)) issues.push({ path: `usage_alerts.${key}`, message: "Must be a non-negative number." });
    if (config.artifacts?.retention_days !== undefined && (!Number.isInteger(config.artifacts.retention_days) || config.artifacts.retention_days < 1)) issues.push({ path: "artifacts.retention_days", message: "Must be a positive integer." });
    if (config.artifacts?.max_bytes !== undefined && (!Number.isInteger(config.artifacts.max_bytes) || config.artifacts.max_bytes < 1)) issues.push({ path: "artifacts.max_bytes", message: "Must be a positive integer." });
    if (config.activity?.enabled && !config.activity.token) issues.push({ path: "activity.token", message: "Required when activity endpoint is enabled." });
    if (config.tools?.deno_enabled !== false) {
        try {
            const result = Bun.spawnSync({ cmd: [process.env.DENO_BIN || `${process.env.HOME || ""}/.deno/bin/deno`, "--version"], stdout: "pipe", stderr: "pipe" });
            if (result.exitCode !== 0) issues.push({ path: "tools.deno_enabled", message: "Deno is required but unavailable." });
        } catch { issues.push({ path: "tools.deno_enabled", message: "Deno is required but unavailable." }); }
    }
    for (const [name, mount] of Object.entries(config.mounts || {})) {
        if (!existsSync(mount)) issues.push({ path: `mounts.${name}`, message: `Path does not exist: ${mount}` });
        else if (!statSync(mount).isDirectory()) issues.push({ path: `mounts.${name}`, message: `Path is not a directory: ${mount}` });
    }
    return issues;
}

export function validateConfigFile(): ConfigIssue[] {
    if (!existsSync(getConfigPath())) return [{ path: "config", message: `File not found: ${getConfigPath()}` }];
    return [];
}
