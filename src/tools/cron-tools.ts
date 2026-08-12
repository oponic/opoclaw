import { cancelJob, createJob, getJob, listJobs, nextCronRun, validateCron } from "../jobs.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

export const CRON_TOOLS = {
    create_cron: defineTool(
        "create_cron",
        "Create a durable five-field cron job. The job sends its result to this conversation when it runs.",
        {
            schedule: { type: "string", description: "Five-field cron expression, such as '0 9 * * 1-5'." },
            prompt: { type: "string", description: "Task to run at each scheduled occurrence." },
            label: { type: "string", description: "Optional label for this schedule." },
        },
        ["schedule", "prompt"],
        {
            toolset: "scheduling", keywords: ["cron", "schedule", "recurring", "timer"], capabilities: ["schedule", "message"], requiresApproval: true,
            handler: async (args, { session, config }) => {
                const schedule = String(args.schedule || "").trim();
                if (!validateCron(schedule)) throw new Error("schedule must be a supported five-field cron expression.");
                const prompt = String(args.prompt || "").trim();
                if (!prompt) throw new Error("prompt is required.");
                const nextRunAt = nextCronRun(schedule, new Date(), config.cron?.timezone)?.toISOString();
                const job = await createJob({ type: "cron", label: String(args.label || "cron job"), request: prompt, schedule, nextRunAt, target: (session as any).deliveryTarget });
                return `Cron job created: ${job.id} (${schedule}); next run ${nextRunAt || "unknown"}.`;
            },
        },
    ),
    list_jobs: defineTool(
        "list_jobs", "List durable Opoclaw jobs, including cron schedules and executions.", {}, [],
        { toolset: "scheduling", keywords: ["jobs", "cron", "background"], capabilities: ["read"], handler: async () => JSON.stringify(await listJobs(), null, 2) },
    ),
    get_job: defineTool(
        "get_job", "Get a durable job by ID.", { id: { type: "string", description: "Job ID." } }, ["id"],
        { toolset: "scheduling", keywords: ["job", "status"], capabilities: ["read"], handler: async (args) => JSON.stringify(await getJob(String(args.id || "")), null, 2) },
    ),
    cancel_job: defineTool(
        "cancel_job", "Cancel a durable timer, cron, subagent, or Deno job.", { id: { type: "string", description: "Job ID." } }, ["id"],
        { toolset: "scheduling", keywords: ["cancel", "job"], capabilities: ["schedule"], requiresApproval: true, handler: async (args) => (await cancelJob(String(args.id || ""))) ? "Job cancelled." : "Job not found." },
    ),
} satisfies Record<string, ToolDefinition>;
