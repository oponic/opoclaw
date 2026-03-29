import {
    Client,
    GatewayIntentBits,
    Message,
    Events,
    type TextChannel,
    type MessagePayload,
    type MessageReplyOptions,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ComponentType,
} from "discord.js";
import { resolve } from "path";
import { unlink, readFile as readFileFs } from "fs/promises";
import { readFileAsync } from "../workspace.ts";
import { runAgent, summarizeToolBatch, type Message as ChatMessage, type ToolCall } from "../agent.ts";
import { getFilePath } from "../workspace.ts";
import { pendingFileSend, clearPendingFileSend } from "../tools.ts";

import { getActiveProvider, getSemanticSearchEnabled, getVisionEnabled, loadConfig, useTomlFiles } from "../config.ts";
import { listSkills } from "../skills.ts";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
});

const EYES = "👀";
const THINKING = "🤔";
const TOOL = "🔧";
const APPROVAL_TOOLS = new Set(["edit_config", "restart_gateway", "hibernate_gateway", "update_opoclaw"]);
const APPROVAL_TIMEOUT_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const OP_DIR = resolve(import.meta.dir, "../..");
const HIBERNATE_FILE = resolve(OP_DIR, ".gateway.hibernate");
const SYSTEM_PROMPT_FILE = resolve(import.meta.dir, "../SYSTEM.md");
const dec = new TextDecoder();
let lastUpdateCheck = 0;
let cachedUpdateTag: string | null = null;
let cachedUpdateChannel: "stable" | "unstable" | null = null;

function runGit(cmd: string): string | null {
    try {
        const p = Bun.spawnSync({
            cmd: ["bash", "-lc", cmd],
            cwd: OP_DIR,
            stdout: "pipe",
            stderr: "pipe",
        });
        if (p.exitCode !== 0) return null;
        return dec.decode(p.stdout).trim();
    } catch {
        return null;
    }
}

async function getUpdateTag(): Promise<string | null> {
    const now = Date.now();
    const channel = (loadConfig().update_channel as any) || "stable";
    if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS && cachedUpdateChannel === channel) {
        return cachedUpdateTag;
    }
    lastUpdateCheck = now;
    cachedUpdateChannel = channel;

    const currentTag = runGit("git describe --tags --abbrev=0 2>/dev/null || echo ''");
    if (!currentTag) {
        cachedUpdateTag = null;
        return null;
    }
    runGit("git fetch --tags 2>/dev/null || true");
    const tagsRaw = runGit("git tag --sort=-v:refname") || "";
    const tags = tagsRaw.split("\n").map((t) => t.trim()).filter(Boolean);
    const latestTag = pickLatestTag(tags, channel, currentTag);
    if (latestTag && latestTag !== currentTag) {
        cachedUpdateTag = latestTag;
        return latestTag;
    }
    cachedUpdateTag = null;
    return null;
}

function isStableTag(tag: string): boolean {
    if (!tag) return false;
    if (tag.includes("-")) return false;
    return !/(alpha|beta|rc)/i.test(tag);
}

function baseVersion(tag: string): string {
    return tag.replace(/^v/i, "").split("-")[0] || tag;
}

function isPrereleaseTag(tag: string): boolean {
    return tag.includes("-") || /(alpha|beta|rc)/i.test(tag);
}

function pickLatestTag(tags: string[], channel: "stable" | "unstable", currentTag: string): string | null {
    const currentIndex = tags.indexOf(currentTag);
    const candidates = currentIndex >= 0 ? tags.slice(0, currentIndex) : tags;
    const currentIsStable = isStableTag(currentTag);
    const currentBase = baseVersion(currentTag);
    for (const tag of candidates) {
        if (currentIsStable && isPrereleaseTag(tag) && baseVersion(tag) === currentBase) {
            continue;
        }
        if (channel === "unstable") return tag;
        if (isStableTag(tag)) return tag;
    }
    return null;
}

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

async function isHibernating(): Promise<boolean> {
    try {
        return await Bun.file(HIBERNATE_FILE).exists();
    } catch {
        return false;
    }
}

async function setHibernating(on: boolean): Promise<void> {
    if (on) {
        await Bun.write(HIBERNATE_FILE, new Date().toISOString());
    } else {
        try {
            await unlink(HIBERNATE_FILE);
        } catch {
        }
    }
}

async function removeReaction(msg: Message, emoji: string): Promise<void> {
    try {
        const reaction = msg.reactions.cache.get(emoji);
        if (reaction) await reaction.users.remove(client.user!.id);
    } catch {
    }
}

async function addReaction(msg: Message, emoji: string): Promise<void> {
    try {
        await msg.react(emoji);
    } catch {
    }
}

async function buildChannelHistory(msg: Message): Promise<ChatMessage[]> {
    const messages = await msg.channel.messages.fetch({ limit: 50 });
    const sorted = Array.from(messages.values()).sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    const history: ChatMessage[] = [];
    for (const m of sorted) {
        if (m.id === msg.id) continue;

        const isBot = m.author.id === client.user!.id;
        let text = m.content.replace(/<@!?\d+>/g, "").trim();
        if (!text && m.attachments.size === 0) continue;

        const reactionList = Array.from(m.reactions.cache.values())
            .map((r) => `${r.emoji.name}${r.count && r.count > 1 ? `×${r.count}` : ""}`)
            .join(" ");
        const reactionSuffix = reactionList ? ` (reactions: ${reactionList})` : "";
        const idPrefix = `[id:${m.id}] `;

        if (isBot) {
            history.push({ role: "assistant", content: `${idPrefix}${text}${reactionSuffix}` });
        } else {
            history.push({
                role: "user",
                content: `${idPrefix}[${m.author.displayName}]: ${text || "(attachment)"}${reactionSuffix}`,
            });
        }
    }

    return history;
}


export async function startDiscord(): Promise<void> {
const startupConfig = loadConfig();
console.log(`[gateway] Active provider: ${getActiveProvider(startupConfig)}`);
const discordCfg = startupConfig.channel?.discord;
if (!discordCfg?.enabled) {
    return;
}
client.on(Events.MessageCreate, async (msg: Message) => {
    const config = loadConfig();
    // Always ignore our own messages
    if (msg.author.id === client.user!.id) return;

    // Ignore other bots unless allowBots is on
    const isBot = msg.author.bot;
    if (isBot && !config.channel?.discord?.allow_bots) return;

    const isMention = msg.mentions.users.has(client.user!.id);

    let isReplyToBot = false;
    if (msg.reference?.messageId) {
        try {
            const referenced = await msg.channel.messages.fetch(msg.reference.messageId);
            isReplyToBot = referenced.author.id === client.user!.id;
        } catch {
        }
    }

    // Only respond to mentions or replies
    if (!isMention && !isReplyToBot) return;

    if (await isHibernating()) {
        const authorizedUserId = config.authorized_user_id?.trim();
        if (!authorizedUserId) {
            await (msg.channel as TextChannel).send(
                "-# Permission denied: `authorized_user_id` is not set in config.toml."
            );
            return;
        }

        const channel = msg.channel as TextChannel;
        const notice = await channel.send("-# Requesting permission...");
        const embed = new EmbedBuilder()
            .setTitle("Wake Gateway?")
            .setDescription("The gateway is hibernating. Approve to wake it and continue.")
            .setColor(0x242429);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("wake:yes").setLabel("Yes").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("wake:no").setLabel("No").setStyle(ButtonStyle.Danger),
        );
        const prompt = await channel.send({ embeds: [embed], components: [row] });

        let approved = false;
        const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
        while (Date.now() < expiresAt) {
            const remaining = expiresAt - Date.now();
            try {
                const interaction = await prompt.awaitMessageComponent({
                    componentType: ComponentType.Button,
                    time: remaining,
                });
                if (interaction.user.id !== authorizedUserId) {
                    await interaction.reply({
                        content: "You are not authorized to approve this action.",
                        ephemeral: true,
                    });
                    continue;
                }
                approved = interaction.customId.endsWith(":yes");
                await interaction.deferUpdate();
                break;
            } catch {
                approved = false;
                break;
            }
        }

        const finalEmbed = EmbedBuilder.from(embed)
            .setColor(0x242429)
            .setFooter({ text: approved ? "Approved" : "Denied or timed out" });
        await prompt.edit({ embeds: [finalEmbed], components: [] });
        await notice.edit(`-# Permission ${approved ? "granted" : "denied"}.`);

        if (!approved) return;
        await setHibernating(false);
    }

    await addReaction(msg, EYES);

    const useToml = useTomlFiles(config);

    const [systemBase, agentsContent, soulContent, identityContent, memoryContent, history, skills] = await Promise.all([
        loadSystemPromptBase(),
        readFileAsync(useToml ? 'agents.toml' : 'AGENTS.md').catch(() => ""),
        readFileAsync(useToml ? 'soul.toml' : 'SOUL.md').catch(() => ""),
        readFileAsync(useToml ? 'identity.toml' : 'IDENTITY.md').catch(() => ""),
        readFileAsync(useToml ? 'memory.toml' : 'MEMORY.md').catch(() => ""),
        buildChannelHistory(msg),
        listSkills(),
    ]);

    const systemPromptParts: string[] = [];
    if (systemBase) systemPromptParts.push(renderSystemPrompt(systemBase));
    if (soulContent) systemPromptParts.push(soulContent);
    if (identityContent) systemPromptParts.push("\n## Your Identity\nThis is your " + (useToml ? "identity.toml" : "IDENTITY.md") + ".\n```\n" + identityContent + "\n```");
    if (agentsContent) systemPromptParts.push("\n## Operating Instructions\n" + agentsContent);
    if (memoryContent) systemPromptParts.push("\n## Memory\nThis is your " + (useToml ? "memory.toml" : "MEMORY.md") + ". You can edit that file, but be careful not to accidentally erase information in it.\n```\n" + memoryContent + "\n```");
    if (getSemanticSearchEnabled(config)) {
        systemPromptParts.push("\n## Semantic Search\nYou have access to a semantic search command in your shell. Use `semantic-search <query>` and it'll return lines in any file that match embeddings. You don't need to worry about gaming this, remember it's semantic and not keyword based, so even just a description of what you're looking for can work. The command caches efficiently as well.\nThis is the recommended way to search through your memory. You can do multiple searches at once using normal shell syntax like semicolons: `semantic-search <query1>; semantic-search <query2>`");
    }
    if (skills.length > 0) {
        systemPromptParts.push(
            `\n## Skills\nAvailable skills: ${skills.map((s) => `\`${s}\``).join(", ")}\nTo use a skill, call the use_skill tool with the skill name. It will return the skill's SKILL.md instructions before you apply them.`
        );
    }
    systemPromptParts.push(
        `\n## Discord Context\nChannel ID: ${msg.channel.id}\nMessage IDs appear as \`[id:...]\` in history entries. Reactions are shown at the end like \`(reactions: 😄×2)\`. Use the \`react_message\` tool with \`channel_id\` and \`message_id\` to react.`
    );
    if (useToml) {
        systemPromptParts.push("\n## TOML Editing\nIn your shell, you have a convenient CLI for easy editing. You can use `toml <file> <key> push <value>` to push a value to a key, or `toml <file> <key> remove <value>` to remove a value. If the key or file doesn't exist, it will be created for you.\nThis is the primary way you should be managing memory. You can for example use `toml memory.toml notes push \"<something you want to remember>\"` to add a note to your memory, which will persist across sessions.");
    }
    const systemPrompt = systemPromptParts.join("\n") || "You are a helpful assistant.";

    const userText = msg.content.replace(/<@!?\d+>/g, "").trim();
    const idPrefix = `[id:${msg.id}] `;
    const visionEnabled = getVisionEnabled(config);
    const imageAttachments = visionEnabled
        ? Array.from(msg.attachments.values()).filter((a) => (a.contentType || "").startsWith("image/"))
        : [];

    const currentReactionList = Array.from(msg.reactions.cache.values())
        .map((r) => `${r.emoji.name}${r.count && r.count > 1 ? `×${r.count}` : ""}`)
        .join(" ");
    const currentReactionSuffix = currentReactionList ? ` (reactions: ${currentReactionList})` : "";

    if (visionEnabled && imageAttachments.length > 0) {
        const parts: any[] = [];
        const text = `${idPrefix}[${msg.author.displayName}]: ${userText || "(image)"}${currentReactionSuffix}`;
        parts.push({ type: "text", text });
        for (const img of imageAttachments) {
            parts.push({ type: "image_url", image_url: { url: img.url } });
        }
        history.push({ role: "user", content: parts });
    } else {
        history.push({
            role: "user",
            content: `${idPrefix}[${msg.author.displayName}]: ${userText || "(empty message)"}${currentReactionSuffix}`,
        });
    }

    let swappedToThinking = false;
    let gotToolCall = false;

    const onFirstToken = async () => {
        if (swappedToThinking) return;
        swappedToThinking = true;
        addReaction(msg, THINKING);
        removeReaction(msg, EYES);
    };
    const toolMessages: { [id: string]: Message } = {};
    const lessVerboseTools = config.less_verbose_tools ?? false;
    const onToolCall = async (call: ToolCall, uniqueId: string) => {
        if (call.function.name === "deep_research") {
            await (msg.channel as TextChannel).send(`-# Using Deep Research...`);
            return;
        }
        if (APPROVAL_TOOLS.has(call.function.name)) {
            return;
        }
        if (!gotToolCall) {
            await addReaction(msg, TOOL);
            gotToolCall = true;
        }
        if (lessVerboseTools) return;
        // assuming there's only one argument we only want to show that
        let fullText = '-# 🔧  Called `' + call.function.name + '`';
        try {
            const args = JSON.parse(call.function.arguments);
            if (call.function.name === "use_skill" && typeof args.name === "string") {
                fullText = `-# ⚡ Using skill \`${args.name}\``;
            }
            if (call.function.name !== "use_skill") {
                const argEntries = Object.entries(args);
                if (argEntries.length === 1) {
                    fullText += ` with \`${argEntries[0]![1]}\``;
                }
            }

            const lines = args.shell_command.split('\n');
            if (call.function.name === 'shell' && args.shell_command && args.description) {
                let line = lines[0];
                if (line.length > 50) {
                    line = line.slice(0, 50) + '…';
                } else if (lines.length > 1) {
                    line += '…';
                }
                fullText = '-# 🔧  ' + args.description + '  •  `' + line + '`';
            }
        } catch {
        }
        const m = await (msg.channel as TextChannel).send(fullText);
        toolMessages[uniqueId] = m;
    };
    const onToolCallError = async (uniqueId: string, error: Error) => {
        if (lessVerboseTools) {
            await (msg.channel as TextChannel).send(`-# 🛑 Tool error: ${error.message}`);
            return;
        }
        const m = toolMessages[uniqueId];
        if (m) {
            await m.edit(m.content + `  •  🛑 Error: ${error.message}`);
        }
    };

    const onToolBatch = async (calls: ToolCall[], results: any[]) => {
        if (!lessVerboseTools) return;
        try {
            const summary = await summarizeToolBatch(calls, results, config);
            const trimmed = summary.trim();
            if (trimmed && trimmed !== "(no summary)") {
                await (msg.channel as TextChannel).send(`-# ${trimmed}`);
            } else {
                await (msg.channel as TextChannel).send(`-# Advanced the task toward the requested outcome.`);
            }
        } catch (e: any) {
            await (msg.channel as TextChannel).send(`-# 🛑 Tool summary failed: ${e.message}`);
        }
    };

    const onDeepResearchSummary = async (summary: string) => {
        const trimmed = summary.trim();
        if (!trimmed) return;
        await (msg.channel as TextChannel).send(`-# ${trimmed}`);
    };

    const requestToolApproval = async (call: ToolCall, uniqueId: string) => {
        if (!APPROVAL_TOOLS.has(call.function.name)) {
            return { approved: true };
        }

        const authorizedUserId = config.authorized_user_id?.trim();
        if (!authorizedUserId) {
            await (msg.channel as TextChannel).send(
                "-# Permission denied: `authorized_user_id` is not set in config.toml."
            );
            return { approved: false, message: "Not authorized to make this decision." };
        }

        const channel = msg.channel as TextChannel;
        const notice = await channel.send("-# Requesting permission...");

        let argsPreview = "(no args)";
        try {
            const args = JSON.parse(call.function.arguments || "{}");
            if (call.function.name === "edit_config") {
                const key = typeof args.key === "string" ? args.key : "(missing)";
                const value = typeof args.value === "string" ? args.value : String(args.value ?? "(missing)");
                argsPreview = `key: ${key}\nvalue: ${value.length > 200 ? value.slice(0, 200) + "…" : value}`;
            } else if (Object.keys(args).length > 0) {
                const raw = JSON.stringify(args);
                argsPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
            }
        } catch {
        }

        const embed = new EmbedBuilder()
            .setTitle("Authorize Tool Call")
            .setDescription(`Tool: \`${call.function.name}\`\nArgs: ${argsPreview}`)
            .setColor(0x242429);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`approve:${uniqueId}:yes`).setLabel("Yes").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`approve:${uniqueId}:no`).setLabel("No").setStyle(ButtonStyle.Danger),
        );

        const prompt = await channel.send({ embeds: [embed], components: [row] });

        let approved = false;
        const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
        while (Date.now() < expiresAt) {
            const remaining = expiresAt - Date.now();
            try {
                const interaction = await prompt.awaitMessageComponent({
                    componentType: ComponentType.Button,
                    time: remaining,
                });
                if (interaction.user.id !== authorizedUserId) {
                    await interaction.reply({
                        content: "You are not authorized to approve this action.",
                        ephemeral: true,
                    });
                    continue;
                }
                approved = interaction.customId.endsWith(":yes");
                await interaction.deferUpdate();
                break;
            } catch {
                approved = false;
                break;
            }
        }

        const finalEmbed = EmbedBuilder.from(embed)
            .setColor(0x242429)
            .setFooter({ text: approved ? "Approved" : "Denied or timed out" });

        await prompt.edit({ embeds: [finalEmbed], components: [] });
        await notice.edit(`-# Permission ${approved ? "granted" : "denied"}.`);

        if (!approved) {
            return {
                approved: false,
                message: "Not authorized to make this decision.",
            };
        }

        return { approved: true };
    };

    try {
        const { text: responseText, reasoningSummary } = await runAgent(
            history,
            systemPrompt,
            config,
            onFirstToken,
            onToolCall,
            onToolCallError,
            requestToolApproval,
            onToolBatch,
            onDeepResearchSummary,
        );

        // Prefix reasoning summary if it's a real summary (not fallback)
        let finalResponse = responseText;
        if (reasoningSummary && reasoningSummary.length < 200 &&
            !reasoningSummary.includes("no summary") &&
            !reasoningSummary.includes("failed") &&
            !reasoningSummary.startsWith("The user") &&
            !reasoningSummary.startsWith("I need to") &&
            !reasoningSummary.startsWith("The assistant")) {
            finalResponse = `-# ${reasoningSummary}
${responseText}`;
        }

        const updateTag = await getUpdateTag();
        if (updateTag) {
            finalResponse += `\n-# ⚠️ An update is available (${updateTag}). Run \`opoclaw update\` to update, or ask your agent to perform the update.`;
        }

        // Split into chunks
        const chunks = splitMessage(finalResponse);
        let fileSent = false;

        for (let i = 0; i < chunks.length; i++) {
            const content = chunks[i];
            if (!content) continue;

            if (i === 0) {
                // Attach file to first message if pending
                if (pendingFileSend && !fileSent) {
                    try {
                        const filePath = getFilePath(pendingFileSend.path);
                        const attachment = new AttachmentBuilder(filePath, {
                            name: pendingFileSend.path.split("/").pop() || "file",
                        });
                        const replyOpts: MessageReplyOptions = {
                            content: content as string,
                            files: [attachment],
                        };
                        await msg.reply(replyOpts);
                        fileSent = true;
                        clearPendingFileSend();
                    } catch (e: any) {
                        // File send failed, just send text
                        await msg.reply(content as string | MessagePayload | MessageReplyOptions);
                    }
                } else {
                    await msg.reply(content as string | MessagePayload | MessageReplyOptions);
                }
            } else {
                if ("send" in msg.channel) {
                    await (msg.channel as any).send(content);
                }
            }
        }

        // Send remaining file if not yet sent (e.g., no text response)
        if (pendingFileSend && !fileSent) {
            try {
                const filePath = getFilePath(pendingFileSend.path);
                const attachment = new AttachmentBuilder(filePath, {
                    name: pendingFileSend.path.split("/").pop() || "file",
                });
                if ("send" in msg.channel) {
                    await (msg.channel as any).send({
                        content: pendingFileSend.caption || "",
                        files: [attachment],
                    });
                }
            } catch {}
            clearPendingFileSend();
        }

    } catch (err: any) {
        console.error("Agent error:", err);
        await msg.reply(`⚠️ Error: ${err.message}`).catch(() => { });
    }

    if (swappedToThinking) {
        await removeReaction(msg, THINKING);
    }
    await addReaction(msg, EYES);
});

function splitMessage(text: string, maxLen = 1990): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
        let end = i + maxLen;
        if (end < text.length) {
            const nl = text.lastIndexOf("\n", end);
            if (nl > i) end = nl + 1;
        }
        chunks.push(text.slice(i, end));
        i = end;
    }
    return chunks;
}

client.once(Events.ClientReady, (c) => {
    console.log(`Logged in as ${c.user.tag}`);
});

if (!discordCfg?.token) {
    throw new Error("Discord token missing. Set channel.discord.token in config.toml.");
}
await client.login(discordCfg.token);
}
