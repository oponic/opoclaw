import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

const queues = new Map<string, Promise<void>>();

/** Read JSON data, returning fallback when the file is absent or malformed. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
        return fallback;
    }
}

/** Serialize writes for a path and replace files atomically. */
export function writeJson(path: string, value: unknown): Promise<void> {
    const prior = queues.get(path) || Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
        await rename(temp, path);
    });
    queues.set(path, next);
    return next;
}
