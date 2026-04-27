import { EmbedBuilder } from "discord.js";

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

export const POLLS = new Map<string, PollState>();

function makeBar(value: number, total: number, width = 12): string {
    if (total <= 0) return "░".repeat(width);
    const filled = Math.round((value / total) * width);
    return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

export function formatPoll(state: PollState): { embed: EmbedBuilder; content: string } {
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
    if (polls.length === 0) return "";
    const lines = polls.map((p) => {
        const total = p.counts.reduce((a, b) => a + b, 0);
        const options = p.options
            .map((opt, idx) => `${opt}: ${p.counts[idx] || 0}`)
            .join(", ");
        return `• ${p.title}: ${p.question} (${options}) Total: ${total}`;
    });
    return `\n## Active Polls\n${lines.join("\n")}`;
}