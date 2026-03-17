import {
    Client,
    GatewayIntentBits,
    Message,
    Events,
    type TextChannel,
    type MessagePayload,
    type MessageReplyOptions,
    AttachmentBuilder,
} from "discord.js";
import { readFileAsync } from "./workspace.ts";
import { runAgent, type Message as ChatMessage } from "./agent.ts";
import { getFilePath } from "./workspace.ts";
import { pendingFileSend, clearPendingFileSend } from "./tools.ts";

import { loadConfig, getConfigPath } from "./config.ts";
const config = loadConfig();

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

        if (isBot) {
            history.push({ role: "assistant", content: text });
        } else {
            history.push({
                role: "user",
                content: `[${m.author.displayName}]: ${text || "(attachment)"}`,
            });
        }
    }

    return history;
}


client.on(Events.MessageCreate, async (msg: Message) => {
    // Always ignore our own messages
    if (msg.author.id === client.user!.id) return;

    // Ignore other bots unless allowBots is on
    const isBot = msg.author.bot;
    if (isBot && !config.allowBots) return;

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

    await addReaction(msg, EYES);

    const [agentsContent, soulContent, identityContent, history] = await Promise.all([
        readFileAsync("AGENTS.md").catch(() => ""),
        readFileAsync("SOUL.md").catch(() => ""),
        readFileAsync("IDENTITY.md").catch(() => ""),
        buildChannelHistory(msg),
    ]);

    const systemPromptParts: string[] = [];
    if (soulContent) systemPromptParts.push(soulContent);
    if (identityContent) systemPromptParts.push("\n## Your Identity\n" + identityContent);
    if (agentsContent) systemPromptParts.push("\n## Operating Instructions\n" + agentsContent);
    const systemPrompt = systemPromptParts.join("\n") || "You are a helpful assistant.";

    const userText = msg.content.replace(/<@!?\d+>/g, "").trim();
    history.push({
        role: "user",
        content: `[${msg.author.displayName}]: ${userText || "(empty message)"}`,
    });

    let swappedToThinking = false;

    const onFirstToken = async () => {
        if (swappedToThinking) return;
        swappedToThinking = true;
        await removeReaction(msg, EYES);
        await addReaction(msg, THINKING);
    };

    try {
        const { text: responseText, reasoningSummary } = await runAgent(
            history,
            systemPrompt,
            config,
            onFirstToken
        );

        // Prefix reasoning summary if it's a real summary (not fallback)
        let finalResponse = responseText;
        if (reasoningSummary && !reasoningSummary.includes("no summary") && !reasoningSummary.includes("failed")) {
            finalResponse = `-${reasoningSummary}
${responseText}`;
        }

        // Clear previous pending file sends
        clearPendingFileSend();

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

await client.login(config.discordToken);
