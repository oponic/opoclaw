import { defineTool, type ToolDefinition } from "./types.ts";
import type { BackgroundSubagentJob } from "../agent.ts";

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
        {
            handler: async (args, { config, session, onDeepResearchSummary }) => {
                return session.deepResearch(String(args.query || ""), config, onDeepResearchSummary);
            },
        },
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
        {
            handler: async (args, { config, session }) => {
                const preserveRecentRaw = Number(args.preserve_recent_messages ?? 6);
                const preserveRecent = Number.isFinite(preserveRecentRaw)
                    ? Math.max(2, Math.min(20, Math.round(preserveRecentRaw)))
                    : 6;
                return await session.compact(preserveRecent, config);
            },
        },
    ),
    run_subagent: defineTool(
        "run_subagent",
        "Run a subagent instance with a request and return its final response. Note: Subagents cannot call tools.",
        {
            request: {
                type: "string",
                description: "Task/request for the subagent.",
            },
            include_context: {
                type: "boolean",
                description: "Whether to include recent context from the parent (this current agent) when running the subagent. Defaults to true.",
            },
        },
        ["request"],
        {
            handler: async (args, { config, session }) => {
                const request = String(args.request || "").trim();
                if (!request) throw new Error("Missing 'request' argument for run_subagent.");
                return session.runSubagentRequest(request, args.include_context !== false, session.currentSystemPrompt, config);
            },
        },
    ),
    run_background_subagent: defineTool(
        "run_background_subagent",
        "Run a subagent in the background and continue immediately. Result is injected later as a follow-up request to the agent. Note: Subagents cannot call tools.",
        {
            request: {
                type: "string",
                description: "Task/request for the background subagent.",
            },
            include_context: {
                type: "boolean",
                description: "Whether to include recent context from the parent (this current agent) when running the subagent. Defaults to true.",
            },
            label: {
                type: "string",
                description: "Optional label to identify the background subagent run.",
            },
        },
        ["request"],
        {
            handler: async (args, { config, session }) => {
                const request = String(args.request || "").trim();
                if (!request) throw new Error("Missing 'request' argument for run_background_subagent.");
                const includeContext = args.include_context !== false;
                const label = String(args.label || `bg-${Date.now()}`);
                const id = `subbg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const job: BackgroundSubagentJob = { id, label, request, status: "running" };
                session.registerBackgroundJob(job);
                void (async () => {
                    try {
                        job.output = await session.runSubagentRequest(request, includeContext, session.currentSystemPrompt, config);
                        job.status = "done";
                    } catch (e: any) {
                        job.status = "error";
                        job.output = String(e?.message || e || "unknown error");
                    }
                })();
                return `Background subagent started (${id}). Label: ${label}.`;
            },
        },
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
        {
            handler: async (args, { session }) => {
                const seconds = Number(args.seconds);
                if (isNaN(seconds) || seconds <= 0) throw new Error("Invalid 'seconds' argument for timer. Must be a positive number.");
                const label = String(args.label || `timer-${Date.now()}`);
                const id = `timer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const job: BackgroundSubagentJob = { id, label, request: `Timer for ${seconds} seconds`, status: "running" };
                session.registerBackgroundJob(job);
                setTimeout(() => {
                    job.status = "done";
                    job.output = `Timer expired at ${new Date().toLocaleTimeString()}.`;
                }, seconds * 1000);
                return `Timer set for ${seconds} seconds (${id}). Label: ${label}.`;
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
