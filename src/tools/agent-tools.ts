import { defineTool, type ToolDefinition } from "./types.ts";

export const AGENT_TOOLS = {
    deep_research: defineTool(
        "deep_research",
        "Enable Deep Research mode to perform multi-step research and return synthesized markdown documents.",
        {
            query: {
                type: "string",
                description: "Research query or question.",
            },
        },
        ["query"],
    ),
    compact: defineTool(
        "compact",
        "Compress prior conversation context into a few paragraphs via a subagent and replace older context with that summary.",
        {
            preserve_recent_messages: {
                type: "number",
                description: "How many recent messages to preserve verbatim after compaction. Defaults to 6.",
            },
        },
        [],
    ),
    run_subagent: defineTool(
        "run_subagent",
        "Run a subagent instance with a request and return its final response.",
        {
            request: {
                type: "string",
                description: "Task/request for the subagent.",
            },
            include_context: {
                type: "boolean",
                description: "Whether to include recent parent context when running the subagent. Defaults to true.",
            },
        },
        ["request"],
    ),
    run_background_subagent: defineTool(
        "run_background_subagent",
        "Run a subagent in the background and continue immediately. Result is injected later as a follow-up request to the agent.",
        {
            request: {
                type: "string",
                description: "Task/request for the background subagent.",
            },
            include_context: {
                type: "boolean",
                description: "Whether to include recent parent context when running the subagent. Defaults to true.",
            },
            label: {
                type: "string",
                description: "Optional label to identify the background subagent run.",
            },
        },
        ["request"],
    ),
    timer: defineTool(
        "timer",
        "Set a timer for a given duration in seconds. When the timer expires, a message will be sent to you with the current time.",
        {
            seconds: {
                type: "number",
                description: "Duration in seconds.",
            },
            label: {
                type: "string",
                description: "Optional label for the timer.",
            },
        },
        ["seconds"],
    ),
} satisfies Record<string, ToolDefinition>;
