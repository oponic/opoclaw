import { defineTool, type ToolDefinition } from "./types.ts";
import { getModelId, getActiveProvider } from "../config.ts";
import { loadUsage } from "../usage.ts";

export const INFO_TOOLS = {
    session_status: defineTool(
        "session_status",
        "Get information about the current session, including the model, channel, context usage, and recent spending.",
        {},
        [],
        {
            handler: async (_args, { config, session }) => {
                const modelId = getModelId(config);
                const provider = getActiveProvider(config);
                let channel = "unknown";
                if (session.sessionId.startsWith("opoclaw-openai-")) channel = "openai";
                else if (session.sessionId.startsWith("opoclaw-core-")) channel = "core/terminal";
                else if (session.sessionId.includes("discord")) channel = "discord";
                else if (session.sessionId.includes("irc")) channel = "irc";

                const usageStats = await loadUsage();
                const now = new Date();
                const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                const recentSpending = usageStats.sessions
                    .filter(s => new Date(s.timestamp) >= oneDayAgo)
                    .reduce((acc, s) => acc + (s.cost || 0), 0);

                const messageCount = session.messages.length;
                let charCount = 0;
                for (const m of session.messages) {
                    if (typeof m.content === "string") charCount += m.content.length;
                    else if (Array.isArray(m.content)) {
                        for (const part of m.content) {
                            if (part.type === "text") charCount += (part.text || "").length;
                        }
                    }
                }
                const estimatedTokens = Math.ceil(charCount / 4);

                return [
                    "Session Status:",
                    `- Model: ${modelId} (${provider})`,
                    `- Channel: ${channel}`,
                    `- Context Usage: ~${estimatedTokens} tokens (${charCount} chars) in ${messageCount} messages.`,
                    `- Context Window: Model-dependent (check provider documentation for ${modelId}).`,
                    `- Spending (last 24h): $${recentSpending.toFixed(4)}`,
                ].join("\n");
            },
        },
    ),
    get_time: defineTool(
        "get_time",
        "Get the current time as an ISO 8601 datetime string and UNIX epoch. The result does not update automatically — call this tool again every time you need the current time.",
        {},
        [],
        {
            handler: async () => {
                const now = new Date();
                return JSON.stringify({ iso: now.toISOString(), unix: Math.floor(now.getTime() / 1000) });
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
