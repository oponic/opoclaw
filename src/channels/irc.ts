import net from "net";
import tls from "tls";
import { resolve } from "path";
import { readFile as readFileFs } from "fs/promises";
import { runAgent, type Message as ChatMessage } from "../agent.ts";
import { getSemanticSearchEnabled, loadConfig, useTomlFiles } from "../config.ts";
import { readFileAsync } from "../workspace.ts";
import { listSkills } from "../skills.ts";

const SYSTEM_PROMPT_FILE = resolve(import.meta.dir, "../SYSTEM.md");

async function loadSystemPromptBase(): Promise<string> {
    try {
        return await readFileFs(SYSTEM_PROMPT_FILE, "utf-8");
    } catch {
        return "";
    }
}

function renderSystemPrompt(template: string): string {
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
    return template
        .replaceAll("{{DATE}}", date)
        .replaceAll("{{TIME}}", time)
        .replaceAll("{{TIMEZONE}}", tz);
}

function splitIrcMessage(text: string, maxLen = 400): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf(" ", maxLen);
        if (cut <= 0) cut = maxLen;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function parseChannels(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/[ ,]+/)
        .map((c) => c.trim())
        .filter(Boolean);
}

export async function startIRC(): Promise<void> {
    const config = loadConfig();
    const ircCfg = config.channel?.irc;
    if (!ircCfg?.enabled) return;

    const server = ircCfg.server || "localhost";
    const tlsEnabled = ircCfg.tls ?? true;
    const port = ircCfg.port || (tlsEnabled ? 6697 : 6667);
    const nick = ircCfg.nick || "opoclaw";
    const username = ircCfg.username || "opoclaw";
    const realname = ircCfg.realname || "opoclaw";
    const password = ircCfg.password;
    const channels = parseChannels(ircCfg.channels);

    const socket = tlsEnabled
        ? tls.connect({ host: server, port, rejectUnauthorized: false })
        : net.connect({ host: server, port });

    const send = (line: string) => {
        socket.write(line + "\r\n");
    };

    socket.on("connect", () => {
        if (password) send(`PASS ${password}`);
        send(`NICK ${nick}`);
        send(`USER ${username} 0 * :${realname}`);
    });

    const historyByTarget = new Map<string, ChatMessage[]>();

    const pushHistory = (key: string, msg: ChatMessage) => {
        const arr = historyByTarget.get(key) || [];
        arr.push(msg);
        if (arr.length > 50) arr.splice(0, arr.length - 50);
        historyByTarget.set(key, arr);
    };

    socket.on("data", async (data) => {
        const lines = data.toString("utf-8").split("\r\n").filter(Boolean);
        for (const line of lines) {
            if (line.startsWith("PING ")) {
                send(line.replace("PING", "PONG"));
                continue;
            }

            const match = line.match(/^:([^!]+)!.*?\sPRIVMSG\s(\S+)\s:(.*)$/);
            if (!match) continue;

            const sender = match[1]!;
            const target = match[2]!;
            const text = match[3] || "";

            const isDirect = target.toLowerCase() === nick.toLowerCase();
            const mentionRegex = new RegExp(`(^|\b)${nick}(\b|:)`, "i");
            const isMention = mentionRegex.test(text);
            if (!isDirect && !isMention) {
                const key = target.startsWith("#") ? target : sender;
                pushHistory(key, { role: "user", content: `[${sender}]: ${text}` });
                continue;
            }

            const cleaned = text.replace(mentionRegex, "").trim();
            const key = target.startsWith("#") ? target : sender;
            const history = historyByTarget.get(key) || [];

            const useToml = useTomlFiles(config);
            const [systemBase, agentsContent, soulContent, identityContent, memoryContent, skills] = await Promise.all([
                loadSystemPromptBase(),
                readFileAsync(useToml ? "agents.toml" : "AGENTS.md").catch(() => ""),
                readFileAsync(useToml ? "soul.toml" : "SOUL.md").catch(() => ""),
                readFileAsync(useToml ? "identity.toml" : "IDENTITY.md").catch(() => ""),
                readFileAsync(useToml ? "memory.toml" : "MEMORY.md").catch(() => ""),
                listSkills(),
            ]);

            const systemPromptParts: string[] = [];
            if (systemBase) systemPromptParts.push(renderSystemPrompt(systemBase));
            if (soulContent) systemPromptParts.push(soulContent);
            if (identityContent)
                systemPromptParts.push(
                    "\n## Your Identity\nThis is your " +
                        (useToml ? "identity.toml" : "IDENTITY.md") +
                        ".\n```\n" +
                        identityContent +
                        "\n```",
                );
            if (agentsContent) systemPromptParts.push("\n## Operating Instructions\n" + agentsContent);
            if (memoryContent)
                systemPromptParts.push(
                    "\n## Memory\nThis is your " +
                        (useToml ? "memory.toml" : "MEMORY.md") +
                        ". You can edit that file, but be careful not to accidentally erase information in it.\n```\n" +
                        memoryContent +
                        "\n```",
                );
            if (getSemanticSearchEnabled(config)) {
                systemPromptParts.push(
                    "\n## Semantic Search\nYou have access to a semantic search command in your shell. Use `semantic-search <query>` and it'll return lines in any file that match embeddings. You don't need to worry about gaming this, remember it's semantic and not keyword based, so even just a description of what you're looking for can work. The command caches efficiently as well.\nThis is the recommended way to search through your memory. You can do multiple searches at once using normal shell syntax like semicolons: `semantic-search <query1>; semantic-search <query2>`",
                );
            }
            if (skills.length > 0) {
                systemPromptParts.push(
                    `\n## Skills\nAvailable skills: ${skills.map((s) => `\`${s}\``).join(", ")}\nTo use a skill, call the use_skill tool with the skill name. It will return the skill's SKILL.md instructions before you apply them.`,
                );
            }
            if (useToml) {
                systemPromptParts.push(
                    "\n## TOML Editing\nIn your shell, you have a convenient CLI for easy editing. You can use `toml <file> <key> push <value>` to push a value to a key, or `toml <file> <key> remove <value>` to remove a value. If the key or file doesn't exist, it will be created for you.\nThis is the primary way you should be managing memory. You can for example use `toml memory.toml notes push \"<something you want to remember>\"` to add a note to your memory, which will persist across sessions.",
                );
            }

            const systemPrompt = systemPromptParts.join("\n") || "You are a helpful assistant.";

            const userText = cleaned || "(empty message)";
            const historyWithUser = history.concat([{ role: "user", content: `[${sender}]: ${userText}` }]);

            const { text: responseText } = await runAgent(historyWithUser, systemPrompt, config, {
                onFirstToken: () => {},
                onToolCall: () => {},
                onToolCallError: () => {}
            });

            pushHistory(key, { role: "user", content: `[${sender}]: ${userText}` });
            if (responseText && responseText.trim() !== "HEARTBEAT_OK") {
                pushHistory(key, { role: "assistant", content: responseText });
                const targetName = isDirect ? sender : target;
                for (const chunk of splitIrcMessage(responseText)) {
                    send(`PRIVMSG ${targetName} :${chunk}`);
                }
            }
        }
    });

    socket.on("error", (err) => {
        console.error("IRC error:", err.message);
    });

    socket.on("close", () => {
        console.log("IRC connection closed");
    });

    socket.on("ready", () => {
        for (const chan of channels) {
            send(`JOIN ${chan}`);
        }
    });
}
