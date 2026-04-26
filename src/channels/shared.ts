import { resolve } from "path";
import { unlink } from "fs/promises";
import { getSemanticSearchEnabled, useTomlFiles, type OpoclawConfig } from "../config.ts";
import { listSkills } from "../skills.ts";
import { readFile } from "../workspace.ts";

export const OP_DIR = resolve(import.meta.dir, "../..");
export const HIBERNATE_FILE = resolve(OP_DIR, ".gateway.hibernate");
const SYSTEM_PROMPT_FILE = resolve(import.meta.dir, "../SYSTEM.md");

export async function isHibernating(): Promise<boolean> {
    try {
        return await Bun.file(HIBERNATE_FILE).exists();
    } catch {
        return false;
    }
}

export async function setHibernating(value: boolean): Promise<void> {
    if (value) {
        await Bun.write(HIBERNATE_FILE, new Date().toISOString());
        return;
    }
    try {
        await unlink(HIBERNATE_FILE);
    } catch {}
}

const CHANNEL_CONTEXT: Record<string, string> = {
    discord: "You are operating in a Discord channel context.",
    terminal: "You are operating in a terminal (CLI) context.",
    openai: "You are operating via the OpenAI-compatible API.",
    irc: "You are operating in an IRC channel context.",
};

function renderSystemPrompt(template: string, channel: string): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const date = now.toLocaleDateString("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "long",
        day: "2-digit",
    });
    const channelContext = CHANNEL_CONTEXT[channel] ?? `You are operating in a ${channel} context.`;
    return template
        .replaceAll("{{DATE}}", date)
        .replaceAll("{{TIMEZONE}}", tz)
        .replaceAll("{{CHANNEL_CONTEXT}}", channelContext);
}

export async function buildSystemPrompt(config: OpoclawConfig, extraSections: string[] = [], channel = "terminal"): Promise<string> {
    const useToml = useTomlFiles(config);
    const [systemBase, agentsContent, soulContent, identityContent, memoryContent, skills] = await Promise.all([
        Bun.file(SYSTEM_PROMPT_FILE).text().catch(() => ""),
        readFile(useToml ? "agents.toml" : "AGENTS.md").catch(() => ""),
        readFile(useToml ? "soul.toml" : "SOUL.md").catch(() => ""),
        readFile(useToml ? "identity.toml" : "IDENTITY.md").catch(() => ""),
        readFile(useToml ? "memory.toml" : "MEMORY.md").catch(() => ""),
        listSkills(),
    ]);

    const parts: string[] = [];
    if (systemBase) parts.push(renderSystemPrompt(systemBase, channel));
    if (soulContent) parts.push(soulContent);
    if (identityContent) {
        parts.push(
            "\n## Your Identity\nThis is your " + (useToml ? "identity.toml" : "IDENTITY.md") + ".\n```\n" + identityContent + "\n```",
        );
    }
    if (agentsContent) parts.push("\n## Operating Instructions\n" + agentsContent);
    if (memoryContent) {
        parts.push(
            "\n## Memory\nThis is your " + (useToml ? "memory.toml" : "MEMORY.md") + ". You can edit that file, but be careful not to accidentally erase information in it.\n```\n" + memoryContent + "\n```",
        );
    }
    if (getSemanticSearchEnabled(config)) {
        parts.push(
            "\n## Semantic Search\nYou have access to a semantic search command in your shell. Use `semantic-search <query>` and it'll return lines in any file that match embeddings. You don't need to worry about gaming this, remember it's semantic and not keyword based, so even just a description of what you're looking for can work. The command caches efficiently as well.\nThis is the recommended way to search through your memory. You can do multiple searches at once using normal shell syntax like semicolons: `semantic-search <query1>; semantic-search <query2>`",
        );
    }
    if (skills.length > 0) {
        parts.push(
            `\n## Skills\nAvailable skills: ${skills.map((s) => `\`${s}\``).join(", ")}\nTo use a skill, call the use_skill tool with the skill name. It will return the skill's SKILL.md instructions before you apply them.`,
        );
    }
    if (useToml) {
        parts.push(
            "\n## TOML Editing\nIn your shell, you have a convenient CLI for easy editing. You can use `toml <file> <key> push <value>` to push a value to a key, or `toml <file> <key> remove <value>` to remove a value. If the key or file doesn't exist, it will be created for you.\nThis is the primary way you should be managing memory. You can for example use `toml memory.toml notes push \"<something you want to remember>\"` to add a note to your memory, which will persist across sessions.",
        );
    }
    for (const section of extraSections) {
        parts.push(section);
    }

    return parts.join("\n") || "You are a helpful assistant.";
}
