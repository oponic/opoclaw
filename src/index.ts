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
import { runAgent, type Message as ChatMessage, type ToolCall } from "./agent.ts";
import { getFilePath } from "./workspace.ts";
import { pendingFileSend, clearPendingFileSend } from "./tools.ts";

import { getSemanticSearchEnabled, loadConfig } from "./config.ts";

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
    const config = loadConfig();
    // Always ignore our own messages
    if (msg.author.id === client.user!.id) return;

    // Ignore other bots unless allowBots is on
    const isBot = msg.author.bot;
    if (isBot && !config.allow_bots) return;

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

    const [agentsContent, soulContent, identityContent, memoryContent, history] = await Promise.all([
        readFileAsync("AGENTS.md").catch(() => ""),
        readFileAsync("SOUL.md").catch(() => ""),
        readFileAsync("IDENTITY.md").catch(() => ""),
        readFileAsync("MEMORY.md").catch(() => ""),
        buildChannelHistory(msg),
    ]);

    const systemPromptParts: string[] = [];
    if (soulContent) systemPromptParts.push(soulContent);
    if (identityContent) systemPromptParts.push("\n## Your Identity\nThis is your IDENTITY.md.\n```\n" + identityContent + "\n```");
    if (agentsContent) systemPromptParts.push("\n## Operating Instructions\n" + agentsContent);
    if (memoryContent) systemPromptParts.push("\n## Memory\nThis is your MEMORY.md. You can edit that file, but be careful not to accidentally erase information in it.\n```\n" + memoryContent + "\n```");
    if (getSemanticSearchEnabled(config)) {
        systemPromptParts.push("\n## Semantic Search\nYou have access to a semantic search command in your shell. Use `semantic-search <query>` and it'll return lines in any file that match embeddings. You don't need to worry about gaming this, remember it's semantic and not keyword based, so even just a description of what you're looking for can work. The command caches efficiently as well.");
    }
    const systemPrompt = systemPromptParts.join("\n") || "You are a helpful assistant.";

    const userText = msg.content.replace(/<@!?\d+>/g, "").trim();
    history.push({
        role: "user",
        content: `[${msg.author.displayName}]: ${userText || "(empty message)"}`,
    });

    let swappedToThinking = false;
    let gotToolCall = false;

    const onFirstToken = async () => {
        if (swappedToThinking) return;
        swappedToThinking = true;
        addReaction(msg, THINKING);
        removeReaction(msg, EYES);
    };
    const toolMessages: { [id: string]: Message } = {};
    const onToolCall = async (call: ToolCall, uniqueId: string) => {
        if (!gotToolCall) {
            await addReaction(msg, TOOL);
            gotToolCall = true;
        }
        // assuming there's only one argument we only want to show that
        let fullText = '-# 🔧  Called `' + call.function.name + '`';
        try {
            const args = JSON.parse(call.function.arguments);
            const argEntries = Object.entries(args);
            if (argEntries.length === 1) {
                fullText += ` with \`${argEntries[0]![1]}\``;
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
        const m = toolMessages[uniqueId];
        if (m) {
            await m.edit(m.content + `  •  🛑 Error: ${error.message}`);
        }
    };

    try {
        const { text: responseText, reasoningSummary } = await runAgent(
            history,
            systemPrompt,
            config,
            onFirstToken,
            onToolCall,
            onToolCallError,
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

const startupConfig = loadConfig();
await client.login(startupConfig.discord_token);
