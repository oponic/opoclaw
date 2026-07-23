import {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ComponentType, type TextChannel, type Message
} from "../../discord/mini.ts";

export type PollState = {
    channelId: string;
    messageId: string;
    question: string;
    title: string;
    options: string[];
    counts: number[];
    voters: Map<string, number>;
    createdAt: number;
    updatedAt: number;
};

const POLLS = new Map<string, PollState>();

function makeBar(value: number, total: number, width = 12): string {
    if (total <= 0) return "░".repeat(width);
    const filled = Math.round((value / total) * width);
    return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}


function formatPoll(state: PollState): { embed: EmbedBuilder; content: string } {
    const total = state.counts.reduce((a, b) => a + b, 0);
    const lines = state.options.map((opt, idx) => {
        const count = state.counts[idx] || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return `${opt}\n${makeBar(count, total)} ${count} (${pct}%)`;
    });
    const embed = new EmbedBuilder()
        .setTitle(state.title)
        .setDescription([state.question, "", ...lines, "", `Total votes: ${total}`].join("\n"))
        .setColor(0x242429);
    const content = `Poll: ${state.title}\n${state.question}\n` +
        state.options.map((opt, idx) => `${opt}: ${state.counts[idx] || 0}`).join("\n") +
        `\nTotal votes: ${total}`;
    return { embed, content };
}

export function getPollSummary(channelId: string): string {
    const polls = Array.from(POLLS.values()).filter((p) => p.channelId === channelId);
    if (polls.length === 0) return "No active polls";
    const lines = polls.map((p) => {
        const total = p.counts.reduce((a, b) => a + b, 0);
        const options = p.options
            .map((opt, idx) => `${opt}: ${p.counts[idx] || 0}`)
            .join(", ");
        return `• ${p.title}: ${p.question} (${options}) Total: ${total}`;
    });
    return `\n## Active Polls\n${lines.join("\n")}`;
}

export async function handlePoll(msg: Message, title: string, question: string, options: string[]) {
    if (options.length < 2 || options.length > 10) {
        return "Error: poll requires between 2 and 10 options.";
    }
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
