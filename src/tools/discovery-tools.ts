import { defineTool, type ToolDefinition } from "./types.ts";
import { searchToolsets } from "./index.ts";

export const DISCOVERY_TOOLS = {
    tool_search: defineTool(
        "tool_search",
        "Search available toolsets and enable relevant toolsets for this session.",
        {
            query: { type: "string", description: "Task or tool capability to search for." },
            enable_toolsets: { type: "array", items: { type: "string" }, description: "Optional toolsets to enable for this session." },
        },
        ["query"],
        {
            toolset: "discovery", keywords: ["tools", "find", "capability", "toolset"], capabilities: ["read"],
            handler: async (args, { session }) => {
                const matches = searchToolsets(String(args.query || ""));
                const requested = Array.isArray(args.enable_toolsets) ? args.enable_toolsets.map(String) : [];
                for (const toolset of requested) session.enableToolset(toolset);
                return JSON.stringify({ matches, enabledToolsets: session.getEnabledToolsets() }, null, 2);
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
