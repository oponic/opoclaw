import { dirname, join } from "path";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";

export interface UsageStats {
    total: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
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

function getUsageFilePath(): string {
    const rawPath = fileURLToPath(new URL("../usage.json", import.meta.url));
    const dir = dirname(rawPath);
    if (dir === "/" || dir === ".") {
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
    return { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, sessions: [] };
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

export async function recordUsage(usage: any, model: string): Promise<void> {
    if (!usage) return;
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
}
