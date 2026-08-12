import { defineTool, type ToolDefinition } from "./types.ts";
import type { BackgroundSubagentJob } from "../agent.ts";
import { createJob } from "../jobs.ts";
import { registerLocalJobExecutor } from "../job-runner.ts";

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
        "Run a subagent instance with a request and return its final response.",
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
        "Run a subagent in the background and continue immediately. Result is injected later as a follow-up request to the agent.",
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
                const durable = await createJob({ type: "subagent", label, request, target: session.deliveryTarget, ownerSessionId: session.sessionId, nextRunAt: new Date().toISOString() });
                registerLocalJobExecutor(durable.id, async () => {
                    const output = await session.runSubagentRequest(request, includeContext, session.currentSystemPrompt, config);
                    job.output = output;
                    job.status = "done";
                    return output;
                });
                // Execute through the durable runner exactly once. Running it now
                // keeps the foreground-session completion injection responsive;
                // if the process exits first, startup recovery runs the persisted job.
                const { runDueJobs } = await import("../job-runner.ts");
                await runDueJobs();
                setTimeout(() => { if (job.status === "running") job.status = "error"; }, 5 * 60_000);
                return `Background subagent started (${id}; durable job ${durable.id}). Label: ${label}.`;
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
                const durable = await createJob({ type: "timer", label, request: job.request, target: session.deliveryTarget, ownerSessionId: session.sessionId, nextRunAt: new Date(Date.now() + seconds * 1000).toISOString() });
                const { runDueJobs } = await import("../job-runner.ts");
                setTimeout(async () => {
                    await runDueJobs();
                    // Preserve foreground injection even if another queued job
                    // consumed the runner slot before this timer's job is claimed.
                    if (job.status === "running") {
                        job.status = "done";
                        job.output = `Timer expired at ${new Date().toLocaleTimeString()}.`;
                    }
                }, seconds * 1000);
                return `Timer set for ${seconds} seconds (${id}; durable job ${durable.id}). Label: ${label}.`;
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
