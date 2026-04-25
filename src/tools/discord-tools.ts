import { defineTool, discordOnlyHandler, type ToolDefinition } from "./types.ts";

export const DISCORD_TOOLS = {
    react_message: defineTool(
        "react_message",
        "React to a Discord message by ID in a given channel.",
        {
            channel_id: {
                type: "string",
                description: "Discord channel ID containing the message.",
            },
            message_id: {
                type: "string",
                description: "Discord message ID to react to.",
            },
            emoji: {
                type: "string",
                description: "Emoji to react with (unicode or custom emoji like name:id).",
            },
        },
        ["channel_id", "message_id", "emoji"],
        {
            handler: async (args, { config }) => {
                const channelId = String(args.channel_id || "");
                const messageId = String(args.message_id || "");
                const emoji = String(args.emoji || "");
                if (!channelId || !messageId || !emoji) {
                    throw new Error("Missing 'channel_id', 'message_id', or 'emoji' argument for react_message.");
                }
                const token = config.channel?.discord?.token;
                if (!token) throw new Error("Discord token missing in config.");
                const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
                const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                let lastErr = "";
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bot ${token}` } });
                    if (res.ok) return "Reaction added.";

                    if (res.status === 429) {
                        let retryAfterMs = 1000;
                        try {
                            const body: any = await res.json();
                            if (typeof body?.retry_after === "number") {
                                retryAfterMs = Math.max(0, Math.ceil(body.retry_after * 1000));
                            }
                        } catch {
                        }
                        await delay(retryAfterMs);
                        continue;
                    }

                    const body = await res.text().catch(() => "");
                    lastErr = `react_message failed (${res.status}): ${body.slice(0, 200)}`;
                    break;
                }
                throw new Error(lastErr || "react_message failed after retries.");
            },
        },
    ),
    request_permission: defineTool(
        "request_permission",
        "Request authorization from the configured authorized_user_id with a custom message. Discord-only.",
        {
            message: {
                type: "string",
                description: "Message describing what approval is needed.",
            },
            title: {
                type: "string",
                description: "Optional title for the approval prompt.",
            },
        },
        ["message"],
        {
            handler: discordOnlyHandler("request_permission"),
        },
    ),
    question: defineTool(
        "question",
        "Ask a multiple-choice question in Discord and return the selected option.",
        {
            question: {
                type: "string",
                description: "The question to ask.",
            },
            options: {
                type: "array",
                items: { type: "string" },
                description: "Answer options (2-10).",
            },
            title: {
                type: "string",
                description: "Optional title for the embed.",
            },
        },
        ["question", "options"],
        {
            handler: discordOnlyHandler("question"),
        },
    ),
    poll: defineTool(
        "poll",
        "Create a live poll in Discord with dynamic results.",
        {
            question: {
                type: "string",
                description: "The poll question.",
            },
            options: {
                type: "array",
                items: { type: "string" },
                description: "Poll options (2-10).",
            },
            title: {
                type: "string",
                description: "Optional title for the poll embed.",
            },
        },
        ["question", "options"],
        {
            handler: discordOnlyHandler("poll"),
        },
    ),
} satisfies Record<string, ToolDefinition>;
