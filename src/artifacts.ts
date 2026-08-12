import { mkdir, readdir, rm } from "fs/promises";
import { resolve } from "path";
import { readJson, writeJson } from "./storage.ts";

const ARTIFACT_DIR = resolve(import.meta.dir, "../data/artifacts");
const ARTIFACT_INDEX = resolve(import.meta.dir, "../data/artifacts.json");

export type Artifact = {
    id: string;
    name: string;
    mimeType: string;
    path: string;
    createdAt: string;
    sessionId?: string;
    jobId?: string;
    sha256: string;
};

function safeName(name: string): string { return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "artifact"; }

async function index(): Promise<Artifact[]> { return readJson(ARTIFACT_INDEX, []); }
async function saveIndex(items: Artifact[]): Promise<void> { await writeJson(ARTIFACT_INDEX, items); }

async function storedBytes(): Promise<number> {
    let total = 0;
    for (const artifact of await index()) {
        try { total += (await Bun.file(artifact.path).stat()).size; } catch {}
    }
    return total;
}

function inferredMimeType(name: string, supplied?: string): string {
    if (supplied) return supplied;
    if (/\.json$/i.test(name)) return "application/json";
    if (/\.png$/i.test(name)) return "image/png";
    if (/\.jpe?g$/i.test(name)) return "image/jpeg";
    if (/\.pdf$/i.test(name)) return "application/pdf";
    return "text/plain";
}

export async function createArtifact(content: string | Uint8Array, options: { name?: string; mimeType?: string; sessionId?: string; jobId?: string; maxBytes?: number } = {}): Promise<Artifact> {
    await mkdir(ARTIFACT_DIR, { recursive: true });
    const incomingSize = typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
    if (options.maxBytes !== undefined && await storedBytes() + incomingSize > options.maxBytes) throw new Error("Artifact quota exceeded.");
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes as any)).toString("hex");
    const existing = (await index()).find((item) => item.sha256 === sha256 && item.sessionId === options.sessionId && item.jobId === options.jobId);
    if (existing) return existing;
    const id = crypto.randomUUID(), name = safeName(options.name || "artifact.txt"), path = resolve(ARTIFACT_DIR, `${id}-${name}`);
    await Bun.write(path, bytes);
    const artifact: Artifact = { id, name, path, mimeType: inferredMimeType(name, options.mimeType), createdAt: new Date().toISOString(), sessionId: options.sessionId, jobId: options.jobId, sha256 };
    const items = await index(); items.push(artifact); await saveIndex(items);
    return artifact;
}

export async function getArtifact(id: string): Promise<Artifact | null> { return (await index()).find((item) => item.id === id) || null; }
export async function listArtifacts(sessionId?: string): Promise<Artifact[]> { return (await index()).filter((item) => !sessionId || item.sessionId === sessionId); }

export async function cleanupArtifacts(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now(); const kept: Artifact[] = []; let removed = 0;
    for (const artifact of await index()) {
        if (now - new Date(artifact.createdAt).getTime() <= maxAgeMs) { kept.push(artifact); continue; }
        await rm(artifact.path, { force: true }).catch(() => {}); removed++;
    }
    await saveIndex(kept);
    // Remove orphan files left by interrupted metadata creation.
    try { for (const entry of await readdir(ARTIFACT_DIR)) if (!kept.some((artifact) => artifact.path.endsWith(entry))) await rm(resolve(ARTIFACT_DIR, entry), { force: true }); } catch {}
    return removed;
}
