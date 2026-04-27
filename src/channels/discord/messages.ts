import type { Message as ChatMessage } from "../../agent.ts";
import { Message, User, ReactionManager, MessageReferenceType } from "discord.js";
import { client } from "./index.ts";

export function formatAuthor(u: User): string {
    let string = `<@${u.id}> ${u.username}`;
    if(u.username != u.displayName) {
        string += `, display name ${u.displayName}`;
    }
    if(u.id == client.user!.id) {
        string += " (you)";
    } else if (u.bot) {
        string += " (bot)";
    }
    return string;
}

export function formatReactions(rm: ReactionManager): string {
    return Array.from(rm.cache.values())
        .map((r) => `${r.emoji.name}${r.count && r.count > 1 ? `×${r.count}` : ""}`)
        .join(" ");
}

export async function formatDiscordMessage(m: Message, imageAttachments?: { url: string }[]): Promise<ChatMessage | null> {
    let message_formatted = "";
    if(m.reference && m.reference.type == MessageReferenceType.Default && m.reference.messageId) {
        const ref_m = await m.channel.messages.fetch(m.reference.messageId);
        if(ref_m) {
            message_formatted += "=== Referenced Message Metadata ===\n";
            message_formatted += "This message is a reply to the following message:\n";
            message_formatted += `Message ID: ${ref_m.id}\n`;
            message_formatted += `Author: ${formatAuthor(ref_m.author)}\n`;
            const mentions = Array.from(ref_m.mentions.users.values());
            if(mentions.length > 0) {
                message_formatted += "Mentions:\n";
                for(let mention of mentions) {
                    message_formatted += ` - ${formatAuthor(mention)}\n`;
                }
            }
            message_formatted += "=== Referenced Message Content ===\n";
            message_formatted += ref_m.content;
            message_formatted += "\n";
        }
    }

    message_formatted += "=== Metadata ===\n";
    message_formatted += `Message ID: ${m.id}\n`;
    message_formatted += `Author: ${formatAuthor(m.author)}\n`;
    const mentions = Array.from(m.mentions.users.values());
    if(mentions.length > 0) {
        message_formatted += "Mentions:\n";
        for(let mention of mentions) {
            message_formatted += ` - ${formatAuthor(mention)}\n`;
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

export async function buildChannelHistory(msg: Message): Promise<ChatMessage[]> {
    const messages = await msg.channel.messages.fetch({ limit: 40 });
    const sorted = Array.from(messages.values()).sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    const history: ChatMessage[] = [];
    for (const m of sorted) {
        if (m.id === msg.id) continue;
        const formatted = await formatDiscordMessage(m);
        if (formatted) history.push(formatted);
    }

    return history;
}