import { defineTool, type ToolDefinition } from "./types.ts";

export const INFO_TOOLS = {
    session_status: defineTool(
        "session_status",
        "Get information about the current session, including the model, channel, context usage, and recent spending.",
        {},
        [],
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
