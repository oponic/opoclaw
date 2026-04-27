import type { TextChannel } from "discord.js";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ComponentType,
    Message,
} from "discord.js";
import { client } from "./index.ts";

export const APPROVAL_TIMEOUT_MS = 60_000;

export async function sendEmbedApproval(
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

export async function awaitButtonApproval(prompt: Message, authorizedUserId: string): Promise<boolean> {
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