import { appendFile, mkdir, readFile } from "fs/promises";
import { resolve } from "path";

const ACTIVITY_FILE = resolve(import.meta.dir, "../data/activity.jsonl");

export type ActivityEvent = {
    id: string;
    timestamp: string;
    type: string;
    sessionId?: string;
    jobId?: string;
    tool?: string;
    target?: string;
    detail?: Record<string, unknown>;
};

function redact(value: unknown): unknown {
    if (typeof value === "string") return value.length > 500 ? value.slice(0, 500) + "…" : value;
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /(?:key|token|password|secret)$/i.test(key) ? "[redacted]" : redact(item),
    ]));
}

export async function logActivity(event: Omit<ActivityEvent, "id" | "timestamp">): Promise<void> {
    const record: ActivityEvent = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ...event,
        detail: event.detail ? redact(event.detail) as Record<string, unknown> : undefined,
    };
    try {
        await mkdir(resolve(ACTIVITY_FILE, ".."), { recursive: true });
        await appendFile(ACTIVITY_FILE, JSON.stringify(record) + "\n", "utf8");
    } catch (error) {
        console.warn(`[activity] Failed to write event: ${error}`);
    }
}

export async function readActivity(limit = 100, filters: { sessionId?: string; jobId?: string; type?: string } = {}): Promise<ActivityEvent[]> {
    let raw = "";
    try { raw = await readFile(ACTIVITY_FILE, "utf8"); } catch { return []; }
    return raw.split("\n").flatMap((line) => {
        try { return line ? [JSON.parse(line) as ActivityEvent] : []; } catch { return []; }
    }).filter((event) =>
        (!filters.sessionId || event.sessionId === filters.sessionId) &&
        (!filters.jobId || event.jobId === filters.jobId) &&
        (!filters.type || event.type === filters.type),
    ).slice(-Math.max(1, limit));
}
