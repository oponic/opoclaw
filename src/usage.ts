import { dirname, join } from "path";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";

export interface UsageStats {
    total: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
    alerts?: Record<string, string>;
    sessions: Array<{
        timestamp: string;
        model: string;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
    }>;
}

function normalizeWindowsPath(p: string): string {
    if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(p)) {
        return p.slice(1);
    }
    return p;
}

function getUsageFilePath(): string {
    const rawPath = normalizeWindowsPath(fileURLToPath(new URL("../usage.json", import.meta.url)));
    const dir = dirname(rawPath);
    if (dir === "/" || /^[A-Za-z]:\\$/.test(dir) || dir === ".") {
        return join(dirname(rawPath), "data", "usage.json");
    }
    return rawPath;
}

const USAGE_FILE = getUsageFilePath();

export async function loadUsage(): Promise<UsageStats> {
    try {
        const file = Bun.file(USAGE_FILE);
        if (await file.exists()) {
            return await file.json();
        }
    } catch { }
    return { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, alerts: {}, sessions: [] };
}

async function saveUsage(stats: UsageStats): Promise<void> {
    try {
        await mkdir(dirname(USAGE_FILE), { recursive: true });
    } catch (err) {
        console.warn(`Could not create directory for usage file: ${err}`);
    }
    try {
        await Bun.write(USAGE_FILE, JSON.stringify(stats, null, 2));
    } catch (err) {
        console.warn(`Could not write usage file: ${err}`);
    }
}

export async function getSessionCost(model: string, hours = 24): Promise<number> {
    const since = Date.now() - hours * 60 * 60 * 1000;
    return (await loadUsage()).sessions.filter((session) => session.model === model && new Date(session.timestamp).getTime() >= since).reduce((total, session) => total + (session.cost || 0), 0);
}

export async function getRollingCost(hours = 24): Promise<number> {
    const since = Date.now() - hours * 60 * 60 * 1000;
    return (await loadUsage()).sessions
        .filter((session) => new Date(session.timestamp).getTime() >= since)
        .reduce((total, session) => total + (session.cost || 0), 0);
}

export async function recordUsage(usage: any, model: string, thresholds = [1, 2]): Promise<number[]> {
    if (!usage) return [];
    const beforeCost = await getRollingCost();
    const stats = await loadUsage();
    const entry = {
        timestamp: new Date().toISOString(),
        model,
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: usage.prompt_tokens_details?.cache_write_tokens || 0,
        cost: usage.cost || 0,
    };
    stats.sessions.push(entry);
    stats.total.input += entry.input;
    stats.total.output += entry.output;
    stats.total.cacheRead += entry.cacheRead;
    stats.total.cacheWrite += entry.cacheWrite;
    stats.total.cost += entry.cost;
    if (stats.sessions.length > 500) {
        stats.sessions = stats.sessions.slice(-500);
    }
    await saveUsage(stats);
    const afterCost = beforeCost + entry.cost;
    const now = new Date().toISOString();
    stats.alerts ||= {};
    const crossed = thresholds.filter((threshold) => beforeCost < threshold && afterCost >= threshold);
    const fresh = crossed.filter((threshold) => {
        const previous = stats.alerts![String(threshold)];
        return !previous || new Date(previous).getTime() < Date.now() - 24 * 60 * 60 * 1000;
    });
    for (const threshold of fresh) stats.alerts[String(threshold)] = now;
    if (fresh.length) await saveUsage(stats);
    return fresh;
}
