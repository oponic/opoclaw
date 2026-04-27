import {
    Client,
    GatewayIntentBits,
    Message,
    Events,
    type TextChannel,
    AttachmentBuilder,
    type MessagePayload,
    type MessageReplyOptions,
    EmbedBuilder,
} from "discord.js";
export { Message as DiscordMessage };
export type {ClientUser};
import { AgentSession, type Message as ChatMessage, type ToolCall } from "../../agent.ts";
import { requiresToolApproval } from "../../tools/index.ts";
import { getFilePath } from "../../workspace.ts";
import { getVisionEnabled, loadConfig, getActiveProvider, getModelId } from "../../config.ts";
import { isHibernating, setHibernating, buildSystemPrompt, OP_DIR } from "../shared.ts";
import { getUpdateTag } from "../../utils.ts";

export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
});

export { formatDiscordMessage, buildChannelHistory } from "./messages.ts";

export const channelSessions = new Map<string, AgentSession>();

const EYES = "👀";
const THINKING = "🤔";

async function addReaction(msg: Message, emoji: string): Promise<void> {
    try {
        await msg.react(emoji);
    } catch {
    }
}

async function removeReaction(msg: Message, emoji: string): Promise<void> {
    try {
        const reaction = msg.reactions.cache.get(emoji);
        if (reaction) await reaction.users.remove(client.user!.id);
    } catch {
    }
}

import { getPollSummary } from "./polls.ts";
import { sendEmbedApproval } from "./interactions.ts";
import { sanitizeModelOutput, splitMessage } from "./responses.ts";
import { createToolCallbacks, requestToolApproval, executeTool } from "./tools.ts";
import { registerSlashCommands, handleSlashCommand } from "./commands.ts";
import type { OpoclawConfig } from "../../config.ts";

export async function startDiscord(): Promise<void> {
    const startupConfig = loadConfig();
    console.log(`[gateway] Active provider: ${getActiveProvider(startupConfig)}`);
    const discordCfg = startupConfig.channel?.discord;
    if (!discordCfg?.enabled) {
        return;
    }

    client.on(Events.MessageCreate, async (msg: Message) => {
        const config = loadConfig();
        if (msg.author.id === client.user!.id) return;

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

        let session = channelSessions.get(msg.channelId);
        if (!session) {
            session = new AgentSession(`opoclaw-discord-${client.user!.id}-${msg.channelId}-${Date.now()}`);
            channelSessions.set(msg.channelId, session);
            for (const m of await buildChannelHistory(msg)) {
                session.addMessage(m);
            }
        }

        if (!isMention && !isReplyToBot) {
            const formatted = await formatDiscordMessage(msg);
            if (formatted) session.addMessage(formatted);
            return;
        }

        if (await isHibernating()) {
            const authorizedUserId = config.authorized_user_id?.trim();
            if (!authorizedUserId) {
                await (msg.channel as TextChannel).send(
                    "-# Permission denied: `authorized_user_id` is not set in config.toml."
                );
                return;
            }

            const channel = msg.channel as TextChannel;
            const embed = new EmbedBuilder()
                .setTitle("Wake Gateway?")
                .setDescription("The gateway is hibernating. Approve to wake it and continue.")
                .setColor(0x242429);
            const approved = await sendEmbedApproval(channel, authorizedUserId, embed, "wake:yes", "wake:no");

            if (!approved) return;
            await setHibernating(false);
        }

        await addReaction(msg, EYES);

        const extraSections = [
            `\n## Discord Context\nChannel ID: ${msg.channel.id}\nMessage IDs appear as \`[id:...]\` in history entries. Reactions are shown at the end like \`(reactions: 😄×2)\`. Use the \`react_message\` tool with \`channel_id\` and \`message_id\` to react.\nNever include \`[id:...]\` in your replies; IDs are only for tool calls.`,
        ];
        const pollSummary = getPollSummary(msg.channel.id);
        if (pollSummary) extraSections.push(pollSummary);
        const systemPrompt = await buildSystemPrompt(config, extraSections, "discord");
        const visionEnabled = getVisionEnabled(config);
        const imageAttachments = visionEnabled
            ? Array.from(msg.attachments.values()).filter((a) => (a.contentType || "").startsWith("image/"))
            : [];

        const formatted = await formatDiscordMessage(msg, imageAttachments.length > 0 ? imageAttachments : undefined);
        if (formatted) session.addMessage(formatted);

        let swappedToThinking = false;
        let gotToolCall = false;
        const toolMessages: Record<string, Message> = {};
        const toolCallSummaries = config.tool_call_summaries ?? "full";

        const onFirstToken = async () => {
            if (swappedToThinking) return;
            swappedToThinking = true;
            await addReaction(msg, THINKING);
            await removeReaction(msg, EYES);
        };

        const toolCallbacks = createToolCallbacks(msg, config, toolMessages, toolCallSummaries);

        try {
            const { text: responseText, reasoningSummary } = await session.evaluate(
                systemPrompt,
                config,
                {
                    onFirstToken,
                    onToolCall: (call, uniqueId) => toolCallbacks.onToolCall(call, uniqueId),
                    onToolCallError: (uniqueId, error) => toolCallbacks.onToolCallError(uniqueId, error),
                    onToolBatch: (calls, results, sessionId) => toolCallbacks.onToolBatch(calls, results, sessionId),
                    requestToolApproval: (call, uniqueId) => requestToolApproval(call, uniqueId, msg, config),
                    onDeepResearchSummary: async (summary: string) => {
                        const trimmed = summary.trim();
                        if (!trimmed) return;
                        await (msg.channel as TextChannel).send(`-# ${trimmed}`);
                    },
                    executeTool: (call, args) => executeTool(call, args, msg, config),
                }
            );

            let finalResponse = responseText;
            if (reasoningSummary && reasoningSummary.length < 200 &&
                !reasoningSummary.includes("no summary") &&
                !reasoningSummary.includes("failed") &&
                !reasoningSummary.startsWith("The user") &&
                !reasoningSummary.startsWith("I need to") &&
                !reasoningSummary.startsWith("The assistant")) {
                finalResponse = `-# ${reasoningSummary}\n${responseText}`;
            }

            finalResponse = sanitizeModelOutput(finalResponse);

            if (config.show_update_notification ?? true) {
                const updateTag = await getUpdateTag();
                if (updateTag) {
                    finalResponse += `\n-# ⚠️ An update is available (${updateTag}). Run \`opoclaw update\` to update, or ask your agent to perform the update.`;
                }
            }

            if (!finalResponse.trim() || finalResponse.trim() === "HEARTBEAT_OK") {
                return;
            }

            await sendResponse(msg, finalResponse, session, config);

        } catch (err: any) {
            console.error("Agent error:", err);
            await msg.reply(`⚠️ Error: ${err.message}`).catch(() => { });
        }

        if (swappedToThinking) {
            await removeReaction(msg, THINKING);
        }
        await addReaction(msg, EYES);
    });

    client.once(Events.ClientReady, async (c) => {
        console.log(`Logged in as ${c.user.tag}`);
        await registerSlashCommands(discordCfg);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        await handleSlashCommand(interaction);
    });

    if (!discordCfg?.token) {
        throw new Error("Discord token missing. Set channel.discord.token in config.toml.");
    }
    await client.login(discordCfg.token);
}

async function sendResponse(
    msg: Message,
    finalResponse: string,
    session: any,
    config: OpoclawConfig,
): Promise<void> {
    const chunks = splitMessage(finalResponse);
    let fileSent = false;

    for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i];
        if (!content) continue;

        if (i === 0) {
            if (session.pendingFileSend && !fileSent) {
                try {
                    const filePath = getFilePath(session.pendingFileSend.path, config.mounts);
                    const attachment = new AttachmentBuilder(filePath, {
                        name: session.pendingFileSend.path.split("/").pop() || "file",
                    });
                    const replyOpts: MessageReplyOptions = {
                        content: content as string,
                        files: [attachment],
                    };
                    await msg.reply(replyOpts);
                    fileSent = true;
                    session.pendingFileSend = null;
                } catch (e: any) {
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

    if (session.pendingFileSend && !fileSent) {
        try {
            const filePath = getFilePath(session.pendingFileSend.path, config.mounts);
            const attachment = new AttachmentBuilder(filePath, {
                name: session.pendingFileSend.path.split("/").pop() || "file",
            });
            if ("send" in msg.channel) {
                await (msg.channel as any).send({
                    content: session.pendingFileSend.caption || "",
                    files: [attachment],
                });
            }
        } catch { }
        session.pendingFileSend = null;
    }
}