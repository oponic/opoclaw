import path from "path";
import { readFile, writeFile } from "fs/promises";
import { getConfigPath, parseTOML, toTOML, type OpoclawConfig } from "../config.ts";
import { validateConfig } from "../config-validation.ts";
import { defineTool, type ToolDefinition } from "./types.ts";
import { setHibernating } from "../channels/shared.ts";

const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");

// Spawn a detached helper that waits ~1s (so the tool's reply is sent first),
// then runs `opoclaw <cliArgs>` via the running bun binary. Cross-platform:
// no bash, no `sleep`, and no bare "bun" lookup (which fails on Windows).
function relaunchDetached(cliArgs: string[]): void {
    const inner = JSON.stringify(["run", "src/cli.ts", ...cliArgs]);
    const root = JSON.stringify(PROJECT_ROOT);
    const script =
        `await Bun.sleep(1000); ` +
        `Bun.spawnSync({ cmd: [process.execPath, ...${inner}], cwd: ${root}, ` +
        `stdout: "ignore", stderr: "ignore", stdin: "ignore" });`;
    const proc = Bun.spawn({
        cmd: [process.execPath, "-e", script],
        cwd: PROJECT_ROOT,
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
    });
    if (typeof (proc as any).unref === "function") {
        (proc as any).unref();
    }
}

function setNestedValue(obj: Record<string, any>, keyPath: string, value: any): void {
    const parts = keyPath.split(".").map((part) => part.trim()).filter(Boolean);
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

export const GATEWAY_TOOLS = {
    edit_config: defineTool(
        "edit_config",
        "Update a single key in config.toml at the project root. This is restricted and requires user approval.",
        {
            key: {
                type: "string",
                description: "Config key to update. Use dot notation for sections (e.g. 'provider.ollama.base_url').",
            },
            value: {
                type: "string",
                description: "New value for the key.",
            },
        },
        ["key", "value"],
        {
            requiresApproval: true,
            handler: async (args) => {
                if (!args.key) throw new Error("Missing 'key' argument for edit_config.");
                if (args.value === undefined) throw new Error("Missing 'value' argument for edit_config.");
                const configPath = getConfigPath();
                const raw = await readFile(configPath, "utf-8");
                const parsed = parseTOML(raw);
                setNestedValue(parsed, String(args.key), coerceConfigValue(String(args.value)));
                const issues = validateConfig(parsed as OpoclawConfig);
                if (issues.length > 0) throw new Error(`Config validation failed: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
                await writeFile(configPath, toTOML(parsed), "utf-8");
                const restartRequired = String(args.key).startsWith("channel.") || String(args.key).startsWith("provider.");
                return `Updated config key "${args.key}".${restartRequired ? " Restart the gateway to apply this setting." : " Applied to new work immediately."}`;
            },
        },
    ),
    restart_gateway: defineTool(
        "restart_gateway",
        "Restart the opoclaw gateway. This is restricted and requires user approval.",
        {},
        [],
        {
            requiresApproval: true,
            handler: async () => {
                relaunchDetached(["gateway", "restart"]);
                return "Gateway restart initiated.";
            },
        },
    ),
    hibernate_gateway: defineTool(
        "hibernate_gateway",
        "Hibernate the opoclaw gateway (stop responses until approved to wake). This is restricted and requires user approval.",
        {},
        [],
        {
            requiresApproval: true,
            handler: async () => {
                await setHibernating(true);
                return "Gateway hibernation enabled.";
            },
        },
    ),
    update_opoclaw: defineTool(
        "update_opoclaw",
        "Update opoclaw to the latest version. This is restricted and requires user approval.",
        {},
        [],
        {
            requiresApproval: true,
            handler: async () => {
                relaunchDetached(["update"]);
                return "Update initiated.";
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
