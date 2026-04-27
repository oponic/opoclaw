import { type ToolCall, summarizeToolBatch } from "../../agent.ts";
import { type OpoclawConfig } from "../../config.ts";
import { requiresToolApproval } from "../../tools/index.ts";
import { type Message as DiscordMessage } from "discord.js";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ComponentType,
    StringSelectMenuBuilder,
    type TextChannel,
} from "discord.js";
import { client } from "./index.ts";
import { POLLS, type PollState, formatPoll } from "./polls.ts";
import { sendEmbedApproval } from "./interactions.ts";

const APPROVAL_TIMEOUT_MS = 60_000;

export function createToolCallbacks(
    msg: DiscordMessage,
    config: OpoclawConfig,
    toolMessages: Record<string, DiscordMessage>,
    toolCallSummaries: string,
) {
    return {
        onToolCall: async (call: ToolCall, uniqueId: string) => {
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
            let gotToolCall = false;
            if (!gotToolCall) {
                await addReaction(msg, "🔧");
                gotToolCall = true;
            }
            if (toolCallSummaries === "off" || toolCallSummaries === "minimal") return;
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
                if (call.function.name === 'shell' && args.shell_command && args.description) {
                    const lines = args.shell_command.split('\n');
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
        },
        onToolCallError: async (uniqueId: string, error: Error) => {
            if (toolCallSummaries === "off") return;
            if (toolCallSummaries === "minimal") {
                await (msg.channel as TextChannel).send(`-# 🛑 Tool error: ${error.message}`);
                return;
            }
            const m = toolMessages[uniqueId];
            if (m) {
                await m.edit(m.content + `  •  🛑 Error: ${error.message}`);
            }
        },
        onToolBatch: async (calls: ToolCall[], results: any[], sessionId: string) => {
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
        },
    };
}

export async function requestToolApproval(
    call: ToolCall,
    uniqueId: string,
    msg: DiscordMessage,
    config: OpoclawConfig,
): Promise<{ approved: boolean; message?: string }> {
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
}

export async function executeTool(
    call: ToolCall,
    args: Record<string, any>,
    msg: DiscordMessage,
    config: OpoclawConfig,
): Promise<string | undefined> {
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

    if (call.function.name === "poll") {
        const question = typeof args.question === "string" ? args.question : "";
        const options = Array.isArray(args.options) ? args.options.map(String) : [];
        if (options.length < 2 || options.length > 10) {
            return "Error: poll requires between 2 and 10 options.";
        }
        const title = typeof args.title === "string" && args.title.trim()
            ? args.title.trim()
            : "Poll";

        const state: PollState = {
            channelId: msg.channel.id,
            messageId: "",
            question,
            title,
            options,
            counts: options.map(() => 0),
            voters: new Map(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        const { embed, content } = formatPoll(state);
        const rows: ActionRowBuilder<ButtonBuilder>[] = [];
        for (let i = 0; i < options.length; i += 5) {
            const row = new ActionRowBuilder<ButtonBuilder>();
            for (let j = i; j < Math.min(i + 5, options.length); j++) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`poll:${j}`)
                        .setLabel(options[j]!.slice(0, 80))
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            rows.push(row);
        }

        const pollMessage = await (msg.channel as TextChannel).send({ embeds: [embed], components: rows });
        state.messageId = pollMessage.id;
        POLLS.set(state.messageId, state);

        const updatePollMessage = async () => {
            const updated = formatPoll(state);
            await pollMessage.edit({ embeds: [updated.embed], components: rows });
        };

        const collector = pollMessage.createMessageComponentCollector({
            componentType: ComponentType.Button,
        });

        collector.on("collect", async (interaction) => {
            const [prefix, idxRaw] = interaction.customId.split(":");
            if (prefix !== "poll") return;
            const idx = parseInt(idxRaw || "", 10);
            if (!Number.isFinite(idx) || idx < 0 || idx >= options.length) {
                await interaction.reply({ content: "Invalid poll option.", ephemeral: true });
                return;
            }

            const prior = state.voters.get(interaction.user.id);
            if (prior !== undefined) {
                if (prior === idx) {
                    state.voters.delete(interaction.user.id);
                    state.counts[prior] = Math.max(0, (state.counts[prior] ?? 0) - 1);
                } else {
                    state.counts[prior] = Math.max(0, (state.counts[prior] ?? 0) - 1);
                    state.voters.set(interaction.user.id, idx);
                    state.counts[idx] = (state.counts[idx] ?? 0 ) + 1;
                }
            } else {
                state.voters.set(interaction.user.id, idx);
                state.counts[idx] = (state.counts[idx] ?? 0 ) + 1;
            }

            state.updatedAt = Date.now();
            await updatePollMessage();
            await interaction.deferUpdate();
        });

        collector.on("end", () => {
            POLLS.delete(state.messageId);
        });

        return content;
    }

    return undefined;
}