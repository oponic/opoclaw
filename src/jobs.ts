import { resolve } from "path";
import type { ConversationRef } from "./channels/delivery.ts";
import { logActivity } from "./activity.ts";
import { readJson, writeJson } from "./storage.ts";

const JOB_FILE = resolve(import.meta.dir, "../data/jobs.json");

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type Job = {
    id: string;
    type: "cron" | "timer" | "subagent" | "deno";
    status: JobStatus;
    label: string;
    request: string;
    createdAt: string;
    updatedAt: string;
    target?: ConversationRef;
    ownerSessionId?: string;
    output?: string;
    error?: string;
    cancelled?: boolean;
    schedule?: string;
    nextRunAt?: string;
    leaseUntil?: string;
    attempts?: number;
    deliveryStatus?: "pending" | "delivered" | "failed";
};

async function load(): Promise<Job[]> { return readJson(JOB_FILE, []); }
async function save(jobs: Job[]): Promise<void> { await writeJson(JOB_FILE, jobs); }

export async function createJob(input: Omit<Job, "id" | "status" | "createdAt" | "updatedAt">): Promise<Job> {
    const now = new Date().toISOString();
    const jobs = await load();
    const limit = Number(process.env.OPOCLAW_MAX_JOBS || 100);
    if (jobs.filter((job) => !job.cancelled && job.status !== "completed").length >= limit) throw new Error(`Job limit reached (${limit}).`);
    const job: Job = { ...input, id: crypto.randomUUID(), status: "pending", createdAt: now, updatedAt: now, attempts: 0 };
    jobs.push(job); await save(jobs);
    await logActivity({ type: "job.created", jobId: job.id, detail: { type: job.type, label: job.label } });
    return job;
}

export async function recoverStaleJobs(now = new Date()): Promise<number> {
    const jobs = await load();
    let recovered = 0;
    for (const job of jobs) {
        if (job.status === "running" && (!job.leaseUntil || new Date(job.leaseUntil) <= now) && !job.cancelled) {
            job.status = "pending";
            job.leaseUntil = undefined;
            job.updatedAt = now.toISOString();
            recovered++;
        }
    }
    if (recovered) await save(jobs);
    return recovered;
}

export async function listJobs(): Promise<Job[]> { return load(); }
export async function getJob(id: string): Promise<Job | null> { return (await load()).find((job) => job.id === id) || null; }

export async function updateJob(id: string, patch: Partial<Job>): Promise<Job | null> {
    const jobs = await load(); const job = jobs.find((candidate) => candidate.id === id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() }); await save(jobs);
    await logActivity({ type: "job.updated", jobId: id, detail: { status: job.status } }); return job;
}

export async function cancelJob(id: string): Promise<boolean> { return !!await updateJob(id, { status: "cancelled", cancelled: true }); }

function validCronField(field: string, min: number, max: number): boolean {
    return field.split(",").every((segment) => {
        const [range, stepText] = segment.split("/");
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1 || !range) return false;
        if (range === "*") return true;
        const [startText, endText] = range.split("-");
        const start = Number(startText), end = endText === undefined ? start : Number(endText);
        return Number.isInteger(start) && Number.isInteger(end) && start >= min && end <= max && start <= end;
    });
}

export function validateCron(expression: string): boolean {
    const parts = expression.trim().split(/\s+/);
    return parts.length === 5 && validCronField(parts[0]!, 0, 59) && validCronField(parts[1]!, 0, 23) && validCronField(parts[2]!, 1, 31) && validCronField(parts[3]!, 1, 12) && validCronField(parts[4]!, 0, 6);
}

function fieldMatches(field: string, value: number): boolean {
    return field.split(",").some((segment) => {
        const [rangePart, stepPart] = segment.split("/"); const step = stepPart ? Number(stepPart) : 1;
        if (!Number.isInteger(step) || step < 1) return false;
        let start = 0, end = 99;
        if (rangePart !== "*") {
            const [a, b] = (rangePart || "").split("-"); start = Number(a); end = b ? Number(b) : start;
        }
        return value >= start && value <= end && (value - start) % step === 0;
    });
}

function clockParts(date: Date, timezone?: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
    if (!timezone) return { minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(), month: date.getMonth() + 1, weekday: date.getDay() };
    const formatted = new Intl.DateTimeFormat("en-US", { timeZone: timezone, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hourCycle: "h23" }).formatToParts(date);
    const part = (type: string) => Number(formatted.find((item) => item.type === type)?.value || 0);
    const name = formatted.find((item) => item.type === "weekday")?.value || "Sun";
    return { minute: part("minute"), hour: part("hour"), day: part("day"), month: part("month"), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name) };
}

export function cronMatches(expression: string, date: Date, timezone?: string): boolean {
    if (!validateCron(expression)) return false;
    const [minute, hour, day, month, weekday] = expression.split(/\s+/), clock = clockParts(date, timezone);
    return fieldMatches(minute!, clock.minute) && fieldMatches(hour!, clock.hour) && fieldMatches(day!, clock.day) && fieldMatches(month!, clock.month) && fieldMatches(weekday!, clock.weekday);
}

export function nextCronRun(expression: string, from = new Date(), timezone?: string): Date | null {
    if (!validateCron(expression)) return null;
    const next = new Date(from); next.setSeconds(0, 0); next.setMinutes(next.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; i++) { if (cronMatches(expression, next, timezone)) return next; next.setMinutes(next.getMinutes() + 1); }
    return null;
}

export async function claimDueCronJobs(now = new Date()): Promise<Job[]> {
    const jobs = await load(); const due: Job[] = [];
    for (const job of jobs) {
        if (job.type !== "cron" || job.cancelled || !job.schedule || !job.nextRunAt || new Date(job.nextRunAt) > now) continue;
        if (job.leaseUntil && new Date(job.leaseUntil) > now) continue;
        job.leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString(); job.status = "running"; job.updatedAt = now.toISOString(); due.push({ ...job });
    }
    if (due.length) await save(jobs);
    return due;
}

export async function completeCronRun(id: string, output?: string, error?: string, timezone?: string): Promise<Job | null> {
    const job = await getJob(id); if (!job) return null;
    const next = job.schedule ? nextCronRun(job.schedule, new Date(), timezone) : null;
    return updateJob(id, { status: error ? "failed" : "pending", output, error, nextRunAt: next?.toISOString(), leaseUntil: undefined, attempts: (job.attempts || 0) + 1 });
}
