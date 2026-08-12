import { resolve } from "path";
import { mkdir, appendFile, readdir, readFile as fsReadFile, rm } from "fs/promises";
import { existsSync } from "fs";

// Persistent, append-only log of every top-level interaction the bot has, used
// as the substrate the dreamer reflects over at the end of each UTC day.
const LOG_DIR = resolve(import.meta.dir, "../data/interactions");

export type InteractionKind = "user" | "assistant" | "tool_call" | "tool_result"; // Redacted operational replay is recorded separately in src/replay.ts.

export interface InteractionEvent {
    ts: string;
    session: string;
    kind: InteractionKind;
    content: string;
    name?: string;
}

export function utcDateString(d: Date = new Date()): string {
    return d.toISOString().slice(0, 10);
}

function logFilePath(date: string): string {
    return resolve(LOG_DIR, `${date}.jsonl`);
}

export async function logInteraction(event: Omit<InteractionEvent, "ts">): Promise<void> {
    try {
        await mkdir(LOG_DIR, { recursive: true });
        const record: InteractionEvent = { ts: new Date().toISOString(), ...event };
        await appendFile(logFilePath(utcDateString()), JSON.stringify(record) + "\n", "utf-8");
    } catch (err) {
        console.warn(`[interactions] Failed to log event: ${err}`);
    }
}

export async function listInteractionDates(): Promise<string[]> {
    if (!existsSync(LOG_DIR)) return [];
    try {
        const files = await readdir(LOG_DIR);
        return files
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => f.slice(0, -".jsonl".length))
            .sort();
    } catch {
        return [];
    }
}

export async function readInteractionsForDate(date: string): Promise<InteractionEvent[]> {
    const path = logFilePath(date);
    if (!existsSync(path)) return [];
    const text = await fsReadFile(path, "utf-8").catch(() => "");
    const events: InteractionEvent[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            events.push(JSON.parse(trimmed) as InteractionEvent);
        } catch {
        }
    }
    return events;
}

export async function clearInteractionsForDate(date: string): Promise<void> {
    const path = logFilePath(date);
    if (existsSync(path)) {
        await rm(path, { force: true }).catch(() => {});
    }
}

// Renders a day's events into a readable transcript for the dreamer, capped so
// it never blows past the model's context window.
export function formatInteractions(events: InteractionEvent[], maxChars = 100_000): string {
    const lines = events.map((e) => {
        const head = e.name ? `${e.kind} (${e.name})` : e.kind;
        return `[${e.ts}] [${e.session}] ${head}:\n${e.content}`;
    });
    const text = lines.join("\n\n");
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}
