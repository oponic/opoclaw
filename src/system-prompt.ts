import { resolve } from "path";
import { readFile as readFileFs } from "fs/promises";
import { getSemanticSearchEnabled } from "./config.ts";

export const SYSTEM_PROMPT_FILE = resolve(import.meta.dir, "../SYSTEM.md");

export async function loadSystemPromptBase(): Promise<string> {
    try {
        return await readFileFs(SYSTEM_PROMPT_FILE, "utf-8");
    } catch {
        return "";
    }
}

export interface SystemPromptContext {
    actualShell: boolean;
    platform?: string;
    shell?: string;
    cwd?: string;
    home?: string;
}

export function createSystemPromptContext(config: { actual_shell?: boolean }): SystemPromptContext {
    return {
        actualShell: config.actual_shell ?? false,
        platform: process.platform,
    };
}

export function renderSystemPrompt(template: string, ctx: SystemPromptContext): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const date = now.toLocaleDateString("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "long",
        day: "2-digit",
    });
    const time = now.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const shellModeNote = ctx.actualShell
        ? "Your `shell` tool is a real host shell command runner. It executes commands on the host system in the project workspace and can affect real files and environment state."
        : "Your `shell` tool is not a real shell - it is a WASM mock shell that is nearly identical to a real shell, but it is not connected to the real filesystem or system.";

    const platformNote = ctx.platform
        ? `Current platform: ${ctx.platform}\n`
        : "";

    const shellNote = ctx.shell
        ? `\nShell: ${ctx.shell}`
        : "";

    const cwdNote = ctx.cwd
        ? `\nWorking directory: ${ctx.cwd}`
        : "";

    const homeNote = ctx.home
        ? `\nHome: ${ctx.home}`
        : "";

    const systemInfo = [platformNote, shellNote, cwdNote, homeNote].filter(Boolean).join("");

    return template
        .replaceAll("{{DATE}}", date)
        .replaceAll("{{TIME}}", time)
        .replaceAll("{{TIMEZONE}}", tz)
        .replaceAll("{{SHELL_MODE_NOTE}}", shellModeNote)
        .replaceAll("{{SYSTEM_INFO}}", systemInfo);
}

export interface SystemPromptParts {
    systemBase: string;
    soulContent: string;
    identityContent: string;
    agentsContent: string;
    memoryContent: string;
    skills: string[];
    useToml: boolean;
    config: { actual_shell?: boolean; semantic_search?: boolean };
    extraSections?: string[];
}

export function buildSystemPrompt(parts: SystemPromptParts): string {
    const systemPromptParts: string[] = [];
    const ctx = createSystemPromptContext(parts.config);

    if (parts.systemBase) {
        systemPromptParts.push(renderSystemPrompt(parts.systemBase, ctx));
    }

    if (parts.soulContent) {
        systemPromptParts.push(parts.soulContent);
    }

    if (parts.identityContent) {
        systemPromptParts.push(
            "\n## Your Identity\nThis is your " +
                (parts.useToml ? "identity.toml" : "IDENTITY.md") +
                ".\n```\n" +
                parts.identityContent +
                "\n```",
        );
    }

    if (parts.agentsContent) {
        systemPromptParts.push("\n## Operating Instructions\n" + parts.agentsContent);
    }

    if (parts.memoryContent) {
        systemPromptParts.push(
            "\n## Memory\nThis is your " +
                (parts.useToml ? "memory.toml" : "MEMORY.md") +
                ". You can edit that file, but be careful not to accidentally erase information in it.\n```\n" +
                parts.memoryContent +
                "\n```",
        );
    }

    if (getSemanticSearchEnabled(parts.config)) {
        systemPromptParts.push(
            "\n## Semantic Search\nYou have access to a semantic search command in your shell. Use `semantic-search <query>` and it'll return lines in any file that match embeddings. You don't need to worry about gaming this, remember it's semantic and not keyword based, so even just a description of what you're looking for can work. The command caches efficiently as well.\nThis is the recommended way to search through your memory. You can do multiple searches at once using normal shell syntax like semicolons: `semantic-search <query1>; semantic-search <query2>`",
        );
    }

    if (parts.skills.length > 0) {
        systemPromptParts.push(
            `\n## Skills\nAvailable skills: ${parts.skills.map((s) => `\`${s}\``).join(", ")}\nTo use a skill, call the use_skill tool with the skill name. It will return the skill's SKILL.md instructions before you apply them.`,
        );
    }

    if (parts.useToml) {
        systemPromptParts.push(
            "\n## TOML Editing\nIn your shell, you have a convenient CLI for easy editing. You can use `toml <file> <key> push <value>` to push a value to a key, or `toml <file> <key> remove <value>` to remove a value. If the key or file doesn't exist, it will be created for you.\nThis is the primary way you should be managing memory. You can for example use `toml memory.toml notes push \"<something you want to remember>\"` to add a note to your memory, which will persist across sessions.",
        );
    }

    if (parts.extraSections) {
        systemPromptParts.push(...parts.extraSections);
    }

    return systemPromptParts.join("\n") || "You are a helpful assistant.";
}
