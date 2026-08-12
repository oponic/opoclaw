import { AgentSession } from "./agent.ts";
import { buildSystemPrompt } from "./channels/shared.ts";
import { enqueueDelivery } from "./channels/delivery.ts";
import { claimDueCronJobs, completeCronRun, type Job } from "./jobs.ts";
import { loadConfig } from "./config.ts";
import { nextCronRun } from "./jobs.ts";

let running = false;
let scheduler: ReturnType<typeof setInterval> | null = null;

async function runCronJob(job: Job): Promise<void> {
    const config = loadConfig();
    try {
        const session = new AgentSession(`opoclaw-cron-${job.id}-${Date.now()}`, true);
        await session.addMessage({ role: "user", content: job.request });
        const result = await session.evaluate(await buildSystemPrompt(config, ["\n## Cron Job\nThis is a scheduled task. Return a concise useful result."], "terminal"), config, { onFirstToken: () => {} });
        await completeCronRun(job.id, result.text, undefined, config.cron?.timezone);
        if (job.target && result.text.trim() && result.text.trim() !== "HEARTBEAT_OK") {
            await enqueueDelivery(job.target, result.text, undefined, `cron:${job.id}:${job.leaseUntil}`);
        }
    } catch (error: any) {
        await completeCronRun(job.id, undefined, error?.message || String(error), config.cron?.timezone);
    }
}

export async function runDueCronJobs(): Promise<void> {
    if (running) return;
    let config: ReturnType<typeof loadConfig>;
    try { config = loadConfig(); } catch { return; }
    if (config.cron?.enabled === false) return;
    running = true;
    try {
        // A disabled catch-up policy advances stale schedules without running an
        // unexpected backlog after downtime.
        if (config.cron?.catch_up === false) {
            const { listJobs, updateJob } = await import("./jobs.ts");
            for (const job of await listJobs()) {
                if (job.type === "cron" && job.schedule && job.nextRunAt && new Date(job.nextRunAt) < new Date()) {
                    await updateJob(job.id, { nextRunAt: nextCronRun(job.schedule)?.toISOString() });
                }
            }
        }
        const due = await claimDueCronJobs();
        const limit = Math.max(1, config.cron?.max_jobs ?? 100);
        await Promise.all(due.slice(0, limit).map(runCronJob));
    } finally { running = false; }
}

export function startCronScheduler(): ReturnType<typeof setInterval> {
    if (scheduler) clearInterval(scheduler);
    void runDueCronJobs();
    scheduler = setInterval(() => void runDueCronJobs(), 30_000);
    return scheduler;
}

export function stopCronScheduler(): void {
    if (scheduler) clearInterval(scheduler);
    scheduler = null;
}
