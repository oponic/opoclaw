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
    StringSelectMenuBuilder,
    REST,
    Routes,
    User,
    ReactionManager,
    MessageReferenceType,
} from "discord.js";
import { AgentSession, summarizeToolBatch, type Message as ChatMessage, type ToolCall } from "../../agent.ts";
import { requiresToolApproval } from "../../tools/index.ts";
import { getFilePath } from "../../workspace.ts";
import { getVisionEnabled, loadConfig, getActiveProvider, getModelId } from "../../config.ts";
import { isHibernating, setHibernating, buildSystemPrompt, OP_DIR } from "../shared.ts";
import { exec, getUpdateTag } from "../../utils.ts";
import { getPollSummary, handlePoll } from "./polls.ts";

const COMMANDS = [
    {
        name: "about",
        description: "About this bot",
    },
    {
        name: "info",
        description: "Show information on this claw",
        options: [
            {
                name: "type",
                type: 3,
                description: "on what",
                required: true,
                choices: [
                    { name: "model", value: "model" },
                    { name: "provider", value: "provider" },
                ],
            },
        ],
    },
];

const VERSION = exec("git describe --tags --abbrev=0 2>/dev/null || echo ''", { cwd: OP_DIR })

const EYES = "👀";
const THINKING = "🤔";
const TOOL = "🔧";
const APPROVAL_TIMEOUT_MS = 60_000;

const channelSessions = new Map<string, AgentSession>();

async function removeReaction(client: Client, msg: Message, emoji: string): Promise<void> {
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

async function sendEmbedApproval(
    channel: TextChannel,
    authorizedUserId: string,
    embed: EmbedBuilder,
    yesId: string,
    noId: string,
): Promise<boolean> {
    const notice = await channel.send("-# Requesting permission...");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(yesId).setLabel("Yes").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(noId).setLabel("No").setStyle(ButtonStyle.Danger),
    );
    const prompt = await channel.send({ embeds: [embed], components: [row] });
    const approved = await awaitButtonApproval(prompt, authorizedUserId);
    const finalEmbed = EmbedBuilder.from(embed)
        .setColor(0x242429)
        .setFooter({ text: approved ? "Approved" : "Denied or timed out" });
    await prompt.edit({ embeds: [finalEmbed], components: [] });
    await notice.edit(`-# Permission ${approved ? "granted" : "denied"}.`);
    return approved;
}

async function awaitButtonApproval(prompt: Message, authorizedUserId: string): Promise<boolean> {
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
    return approved;
}

function formatAuthor(client: Client, user: User): string {
    let string = `<@${user.id}> ${user.username}`;
    if(user.username != user.displayName) {
        string += `, display name ${user.displayName}`;
    }
    if(user.id == client.user!.id) {
        string += " (you)";
    } else if (user.bot) {
        string += " (bot)";
    }
    return string;
}

function formatReactions(rm: ReactionManager): string {
    return Array.from(rm.cache.values())
        .map((r) => `${r.emoji.name}${r.count && r.count > 1 ? `×${r.count}` : ""}`)
        .join(" ");
}

export async function formatDiscordMessage(client: Client, m: Message, imageAttachments?: { url: string }[]): Promise<ChatMessage | null> {
    let message_formatted = "";
    if(m.reference && m.reference.type == MessageReferenceType.Default && m.reference.messageId) {
        const ref_m = await m.channel.messages.fetch(m.reference.messageId);
        if(ref_m) {
            message_formatted += "=== Referenced Message Metadata ===\n";
            message_formatted += "This message is a reply to the following message:\n";
            message_formatted += `Message ID: ${ref_m.id}\n`;
            message_formatted += `Author: ${formatAuthor(client, ref_m.author)}\n`;
            const mentions = Array.from(ref_m.mentions.users.values());
            if(mentions.length > 0) {
                message_formatted += "Mentions:\n";
                for(let mention of mentions) {
                    message_formatted += ` - ${formatAuthor(client, mention)}\n`;
                }
            }
            message_formatted += "=== Referenced Message Content ===\n";
            message_formatted += ref_m.content;
            message_formatted += "\n";
        }
    }

    message_formatted += "=== Metadata ===\n";
    message_formatted += `Message ID: ${m.id}\n`;
    message_formatted += `Author: ${formatAuthor(client, m.author)}\n`;
    const mentions = Array.from(m.mentions.users.values());
    if(mentions.length > 0) {
        message_formatted += "Mentions:\n";
        for(let mention of mentions) {
            message_formatted += ` - ${formatAuthor(client, mention)}\n`;
        }
    }
    const reactions = formatReactions(m.reactions);
    if(reactions) {
        message_formatted += `Reactions: ${reactions}\n`;
    }
    message_formatted += "=== Content ===\n";
    
    if (m.author.id === client.user!.id) {
        const cleanedText = m.content
            .split("\n")
            .filter((line: string) => !line.trim().startsWith("-#"))
            .join("\n")
            .trim();
        if (!cleanedText) return null;
        message_formatted += cleanedText;
        return { role: "assistant", content: message_formatted };
    }
    
    message_formatted += m.content;
    
    if (imageAttachments && imageAttachments.length > 0) {
        const parts: any[] = [{ type: "text", text: message_formatted }];
        for (const img of imageAttachments) {
            parts.push({ type: "image_url", image_url: { url: img.url } });
        }
        return { role: "user", content: parts };
    }
    return { role: "user", content: message_formatted };
}

async function buildChannelHistory(client: Client, msg: Message): Promise<ChatMessage[]> {
    const messages = await msg.channel.messages.fetch({ limit: 40 });
    const sorted = Array.from(messages.values()).sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    const history: ChatMessage[] = [];
    for (const m of sorted) {
        if (m.id === msg.id) continue;
        const formatted = await formatDiscordMessage(client, m);
        if (formatted) history.push(formatted);
    }

    return history;
}

function sanitizeModelOutput(text: string): string {
    return text.replace(/\[id:\d+\]\s*/g, "");
}

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

async function handleQuestion(msg: Message, title: string, question: string, options: string[]) {
    if (options.length < 2 || options.length > 10) {
        return "Error: question requires between 2 and 10 options.";
    }
    const channel = msg.channel as TextChannel;
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x242429);
    if (question) {
        embed.setDescription(question);
    }

    const promptId = Math.random().toString(36).slice(2);
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`question:${promptId}`)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            options.map((opt, idx) => ({
                label: opt.length > 100 ? opt.slice(0, 97) + "…" : opt,
                value: String(idx),
            }))
        );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    const prompt = await channel.send({ embeds: [embed], components: [row] });
    let selected: string | null = null;
    let selectedUser = "";
    let selectedUserId = "";

    try {
        const interaction = await prompt.awaitMessageComponent({
            componentType: ComponentType.StringSelect,
            time: APPROVAL_TIMEOUT_MS,
        });
        const idx = parseInt(interaction.values[0] || "", 10);
        selected = Number.isFinite(idx) && options[idx] ? options[idx] : null;
        const member = interaction.member as any;
        selectedUser = member?.displayName || interaction.user.username;
        selectedUserId = interaction.user.id;
        await interaction.deferUpdate();
    } catch {
        selected = null;
    }

    const footer = selected
        ? `Selected: ${selected} (${selectedUser})`
        : "Timed out";
    const finalEmbed = EmbedBuilder.from(embed).setFooter({ text: footer });
    await prompt.edit({ embeds: [finalEmbed], components: [] });

    if (!selected) {
        return "No selection (timed out).";
    }
    return `Selected: ${selected}\nUser: ${selectedUser} (${selectedUserId})`;
}

async function onMessage(client: Client, msg: Message) {
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

    // Get or bootstrap session for this channel
    let session = channelSessions.get(msg.channelId);
    if (!session) {
        session = new AgentSession(`opoclaw-discord-${client.user!.id}-${msg.channelId}-${Date.now()}`);
        channelSessions.set(msg.channelId, session);
        for (const m of await buildChannelHistory(client, msg)) {
            session.addMessage(m);
        }
    }

    // Track all messages for context, but only respond to mentions or replies
    if (!isMention && !isReplyToBot) {
        const formatted = await formatDiscordMessage(client, msg);
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
    const systemPrompt = await buildSystemPrompt(config, extraSections, "discord");
    const visionEnabled = getVisionEnabled(config);
    const imageAttachments = visionEnabled
        ? Array.from(msg.attachments.values()).filter((a) => (a.contentType || "").startsWith("image/"))
        : [];

    const formatted = await formatDiscordMessage(client, msg, imageAttachments.length > 0 ? imageAttachments : undefined);
    if (formatted) session.addMessage(formatted);

    let swappedToThinking = false;
    let gotToolCall = false;

    const onFirstToken = async () => {
        if (swappedToThinking) return;
        swappedToThinking = true;
        addReaction(msg, THINKING);
        removeReaction(client, msg, EYES);
    };
    const toolMessages: { [id: string]: Message } = {};
    const toolCallSummaries = config.tool_call_summaries ?? "full";
    const onToolCall = async (call: ToolCall, uniqueId: string) => {
        if (call.function.name === "deep_research") {
            await (msg.channel as TextChannel).send(`-# Using Deep Research...`);
            return;
        }
        if (call.function.name === "request_permission" || call.function.name === "question" || call.function.name === "poll") {
            return;
        }
        if (requiresToolApproval(call.function.name)) {
            return;
        }
        if (!gotToolCall) {
            await addReaction(msg, TOOL);
            gotToolCall = true;
        }
        if (toolCallSummaries === "off" || toolCallSummaries === "minimal") return;
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
        if (toolCallSummaries === "off") return;
        if (toolCallSummaries === "minimal") {
            await (msg.channel as TextChannel).send(`-# 🛑 Tool error: ${error.message}`);
            return;
        }
        const m = toolMessages[uniqueId];
        if (m) {
            await m.edit(m.content + `  •  🛑 Error: ${error.message}`);
        }
    };

    const onToolBatch = async (calls: ToolCall[], results: any[], sessionId: string) => {
        if (toolCallSummaries !== "minimal") return;
        try {
            const summary = await summarizeToolBatch(calls, results, config, sessionId);
            const trimmed = summary.trim();
            if (trimmed && trimmed !== "(no summary)") {
                await (msg.channel as TextChannel).send(`-# ${trimmed}`);
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
        if (!requiresToolApproval(call.function.name)) {
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
        const approved = await sendEmbedApproval(channel, authorizedUserId, embed, `approve:${uniqueId}:yes`, `approve:${uniqueId}:no`);

        if (!approved) {
            return {
                approved: false,
                message: "Not authorized to make this decision.",
            };
        }

        return { approved: true };
    };

    const executeTool = async (call: ToolCall, args: Record<string, any>): Promise<string | undefined> => {
        if (call.function.name === "request_permission") {
            const authorizedUserId = config.authorized_user_id?.trim();
            if (!authorizedUserId) {
                await (msg.channel as TextChannel).send(
                    "-# Permission denied: `authorized_user_id` is not set in config.toml."
                );
                return "Not authorized to make this decision.";
            }

            const message = typeof args.message === "string" ? args.message : "";
            const title = typeof args.title === "string" && args.title.trim()
                ? args.title.trim()
                : "Permission Request";

            const channel = msg.channel as TextChannel;
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setColor(0x242429);
            if (message) embed.setDescription(message);
            const promptId = Math.random().toString(36).slice(2);
            const approved = await sendEmbedApproval(channel, authorizedUserId, embed, `request:${promptId}:yes`, `request:${promptId}:no`);

            return approved ? "Approved." : "Denied.";
        }

        if (call.function.name === "question") {
            const question = typeof args.question === "string" ? args.question : "";
            const options = Array.isArray(args.options) ? args.options.map(String) : [];
            if (options.length < 2 || options.length > 10) {
                return "Error: question requires between 2 and 10 options.";
            }
            const title = typeof args.title === "string" && args.title.trim()
                ? args.title.trim()
                : "Question";
            return handleQuestion(msg, title, question, options);
        }

        if (call.function.name === "poll") {
            const question = typeof args.question === "string" ? args.question : "";
            const options = Array.isArray(args.options) ? args.options.map(String) : [];
            if (options.length < 2 || options.length > 10) {
                return "Error: poll requires between 2 and 10 options.";
            }
            const title = typeof args.title === "string" && args.title.trim()
                ? args.title.trim()
                : "Poll";

            return handlePoll(msg, title, question, options);
        }

        if(call.function.name === "check_polls") {
            return getPollSummary(msg.channel.id);
        }
        
        return undefined;
    };

    try {
        const { text: responseText, reasoningSummary } = await session.evaluate(
            systemPrompt,
            config,
            {
                onFirstToken,
                onToolCall,
                onToolCallError,
                requestToolApproval,
                onToolBatch,
                onDeepResearchSummary,
                executeTool,
            }
        );

        // Prefix reasoning summary if it's a real summary (not fallback)
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

        // Split into chunks
        const chunks = splitMessage(finalResponse);
        let fileSent = false;

        for (let i = 0; i < chunks.length; i++) {
            const content = chunks[i];
            if (!content) continue;

            if (i === 0) {
                // Attach file to first message if pending
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

    } catch (err: any) {
        console.error("Agent error:", err);
        await msg.reply(`⚠️ Error: ${err.message}`).catch(() => { });
    }

    if (swappedToThinking) {
        await removeReaction(client, msg, THINKING);
    }
    await addReaction(msg, EYES);
};

export async function startDiscord(): Promise<void> {
    const startupConfig = loadConfig();
    console.log(`[gateway] Active provider: ${getActiveProvider(startupConfig)}`);
    const discordCfg = startupConfig.channel?.discord;
    if (!discordCfg?.enabled) {
        return;
    }
    if (!discordCfg?.token) {
        throw new Error("Discord token missing. Set channel.discord.token in config.toml.");
    }

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
        ],
    });

    client.on(Events.MessageCreate, async (msg)=>{onMessage(client, msg)});

    client.once(Events.ClientReady, async (c) => {
        console.log(`Logged in as ${c.user.tag}`);

        const rest = new REST({ version: "10" }).setToken(discordCfg.token!);
        try {
            await rest.put(Routes.applicationCommands(client.user!.id), {body: COMMANDS});
            console.log("[gateway] Registered slash commands");
        } catch (e) {
            console.error("[gateway] Failed to register slash commands:", e);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const tag = VERSION.toLowerCase();
        let releaseBadge = "";
        if (tag.includes("alpha")) releaseBadge = '\u001b[42m alpha \u001b[0m';
        else if (tag.includes("beta")) releaseBadge = '\u001b[41m beta \u001b[0m';
        else if (tag.includes("rc")) releaseBadge = '\u001b[45m rc \u001b[0m';

        if (interaction.commandName === "about") {
            const about = `
\`\`\`ansi
 
 ▄▄███▀                      ▀█              
 ▀▀▄▄▄█▄  ▄▀▀▄ ▄▀▀▄ ▄▀▀▄ ▄▀▀▀ █  ▀▀▀▄ █ █ █  ${releaseBadge}
   █████  ▀▄▄▀ █▄▄▀ ▀▄▄▀ ▀▄▄▄ █▄ ████ ▀▄▀▄▀
    ▀▀▀        █

 \u001b[1mopoclaw ${VERSION}\u001b[0m
 Lightweight Bun AI agent framework
 \u001b[34mhttps://github.com/oponic/opoclaw\u001b[0m
 \u001b[30moponic + others, 2026\u001b[0m
 
\`\`\`
            `;
            await interaction.reply(about);
        }

        if (interaction.commandName === "info") {
            const type = interaction.options.getString("type");
            const config = await loadConfig();
            if (type === "model") {
                const modelId = getModelId(config);
                const provider = getActiveProvider(config);
                await interaction.reply(`**Model:** \`${modelId}\``);
            } else if (type === "provider") {
                const provider = getActiveProvider(config);
                await interaction.reply(`**Provider:** \`${provider}\``);
            }
        }
    });

    try {
        await client.login(discordCfg.token);
    } catch (err: any) {
        const message = String(err?.message || err || "");
        if (message.includes("session_start_limit") || message.includes("reset_after")) {
            throw new Error(
                "Discord login failed while reading gateway information. Check that channel.discord.token is a valid bot token and that the bot can reach the Discord API."
            );
        }
        throw err instanceof Error ? err : new Error(message || "Discord login failed.");
    }
}
