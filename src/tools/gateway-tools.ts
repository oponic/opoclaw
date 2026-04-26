import path from "path";
import { readFile, writeFile } from "fs/promises";
import { getConfigPath, parseTOML, toTOML } from "../config.ts";
import { defineTool, type ToolDefinition } from "./types.ts";
import { setHibernating } from "../channels/shared.ts";

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
                await writeFile(configPath, toTOML(parsed), "utf-8");
                return `Updated config key "${args.key}".`;
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
                const proc = Bun.spawn({
                    cmd: ["bash", "-lc", "sleep 1; bun run src/cli.ts gateway restart"],
                    cwd: path.resolve(import.meta.dir, "../.."),
                    stdout: "ignore",
                    stderr: "ignore",
                    detached: true,
                });
                if (typeof (proc as any).unref === "function") {
                    (proc as any).unref();
                }
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
                const proc = Bun.spawn({
                    cmd: ["bash", "-lc", "sleep 1; bun run src/cli.ts update"],
                    cwd: path.resolve(import.meta.dir, "../.."),
                    stdout: "ignore",
                    stderr: "ignore",
                    detached: true,
                });
                if (typeof (proc as any).unref === "function") {
                    (proc as any).unref();
                }
                return "Update initiated.";
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
