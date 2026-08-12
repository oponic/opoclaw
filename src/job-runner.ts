import { AgentSession } from "./agent.ts";
import { completeCronRun, listJobs, recoverStaleJobs, updateJob, type Job } from "./jobs.ts";
import { loadConfig } from "./config.ts";
import { buildSystemPrompt } from "./channels/shared.ts";
import { enqueueDelivery } from "./channels/delivery.ts";

const active = new Set<string>();
const localExecutors = new Map<string, () => Promise<string>>();
let timer: ReturnType<typeof setInterval> | null = null;

async function finish(job: Job, output?: string, error?: string): Promise<void> {
    let config: any;
    try { config = loadConfig(); } catch { config = {}; }
    if (job.type === "cron") await completeCronRun(job.id, output, error, config.cron?.timezone);
    else await updateJob(job.id, { status: error ? "failed" : "completed", output, error, leaseUntil: undefined });
    if (output?.trim() && job.target) await enqueueDelivery(job.target, output, undefined, `job:${job.id}:${job.updatedAt}`);
}

export function registerLocalJobExecutor(jobId: string, executor: () => Promise<string>): void { localExecutors.set(jobId, executor); }

async function runSubagent(job: Job): Promise<void> {
    const config = loadConfig();
    const session = new AgentSession(`opoclaw-job-${job.id}`, true);
    session.deliveryTarget = job.target;
    await session.addMessage({ role: "user", content: job.request });
    const response = await session.evaluate(await buildSystemPrompt(config, ["\n## Durable Job\nComplete this background request and return the result."], "terminal"), config, { onFirstToken: () => {} });
    await finish(job, response.text);
}
async function runTimer(job: Job): Promise<void> { await finish(job, `Timer expired at ${new Date().toLocaleTimeString()}.`); }
function sessionActiveCount(ownerSessionId?: string): number { return [...active].filter((id) => localExecutors.has(id) || !!ownerSessionId).length; }

export async function runDueJobs(now = new Date()): Promise<void> {
    let config: any;
    try { config = loadConfig(); } catch { config = {}; }
    const maxConcurrent = Math.max(1, config.jobs?.max_concurrent ?? 2), maxPerSession = Math.max(1, config.jobs?.max_per_session ?? 1);
    const jobs = await listJobs();
    for (const job of jobs) {
        if (active.size >= maxConcurrent) break;
        if (active.has(job.id) || job.cancelled || job.status !== "pending" || !job.nextRunAt || new Date(job.nextRunAt) > now) continue;
        const ownerRunning = jobs.filter((candidate) => candidate.status === "running" && candidate.ownerSessionId && candidate.ownerSessionId === job.ownerSessionId).length;
        if (job.ownerSessionId && ownerRunning >= maxPerSession) continue;
        active.add(job.id);
        await updateJob(job.id, { status: "running", leaseUntil: new Date(now.getTime() + 5 * 60_000).toISOString() });
        try {
            const latest = (await listJobs()).find((candidate) => candidate.id === job.id);
            if (latest?.cancelled) { await updateJob(job.id, { status: "cancelled", leaseUntil: undefined }); continue; }
            const executor = localExecutors.get(job.id);
            if (executor) { await finish(job, await executor()); localExecutors.delete(job.id); }
            else if (job.type === "timer") await runTimer(job);
            else if (job.type === "subagent") await runSubagent(job);
        } catch (error: any) { await finish(job, undefined, error?.message || String(error)); }
        finally { active.delete(job.id); }
    }
}
export function startJobRunner(): ReturnType<typeof setInterval> { if (timer) clearInterval(timer); void recoverStaleJobs().then(() => runDueJobs()); timer = setInterval(() => void runDueJobs(), 1_000); return timer; }
export function stopJobRunner(): void { if (timer) clearInterval(timer); timer = null; }
