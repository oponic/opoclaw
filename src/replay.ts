import { resolve } from "path";
import { appendFile, mkdir, readFile } from "fs/promises";

const REPLAY_FILE = resolve(import.meta.dir, "../data/replay.jsonl");
export type ReplayEvent = { id: string; at: string; kind: string; input: unknown; output: unknown };

function redact(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(redact);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [/token|secret|password|api_?key/i.test(key) ? key : key, /token|secret|password|api_?key/i.test(key) ? "[redacted]" : redact(item)]));
}

export async function recordReplay(kind: string, input: unknown, output: unknown): Promise<ReplayEvent> {
    const event: ReplayEvent = { id: crypto.randomUUID(), at: new Date().toISOString(), kind, input: redact(input), output: redact(output) };
    await mkdir(resolve(REPLAY_FILE, ".."), { recursive: true });
    await appendFile(REPLAY_FILE, JSON.stringify(event) + "\n", "utf8");
    return event;
}

export async function loadReplay(): Promise<ReplayEvent[]> {
    try { return (await readFile(REPLAY_FILE, "utf8")).split("\n").flatMap((line) => { try { return line ? [JSON.parse(line) as ReplayEvent] : []; } catch { return []; } }); }
    catch { return []; }
}

export async function replay(events: ReplayEvent[], handler: (event: ReplayEvent) => Promise<unknown>): Promise<unknown[]> {
    const outputs: unknown[] = [];
    for (const event of events) outputs.push(await handler(event));
    return outputs;
}
