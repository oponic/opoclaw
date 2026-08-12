import { resolve } from "path";
import { logActivity } from "../activity.ts";
import { readJson, writeJson } from "../storage.ts";
import { getArtifact } from "../artifacts.ts";

const OUTBOUND_FILE = resolve(import.meta.dir, "../../data/outbound.json");
const MAX_ATTEMPTS = 5;

export type ConversationRef = { channel: "discord" | "signal" | "irc" | "terminal"; conversationId: string; label?: string; ownerId?: string };
export type DeliveryResult = { delivered: boolean; detail?: string };
type Sender = (content: string, attachments?: string[]) => Promise<DeliveryResult>;
type RegisteredTarget = { ref: ConversationRef; send: Sender };
export type OutboundDelivery = { id: string; idempotencyKey: string; target: ConversationRef; content: string; artifacts?: string[]; status: "pending" | "delivered" | "failed"; attempts: number; nextAttemptAt: string; lastError?: string; createdAt: string; updatedAt: string };

const targets = new Map<string, RegisteredTarget>();
let lastActiveKey: string | null = null, draining = false, worker: ReturnType<typeof setInterval> | null = null;
export function conversationKey(ref: ConversationRef): string { return `${ref.channel}:${ref.conversationId}`; }
async function loadQueue(): Promise<OutboundDelivery[]> { return readJson(OUTBOUND_FILE, []); }
async function saveQueue(queue: OutboundDelivery[]): Promise<void> { await writeJson(OUTBOUND_FILE, queue); }
export function registerDeliveryTarget(ref: ConversationRef, send: Sender): void { const key = conversationKey(ref); targets.set(key, { ref, send }); lastActiveKey = key; void drainDeliveryQueue(); }
export function getLastDeliveryTarget(): ConversationRef | null { return lastActiveKey ? targets.get(lastActiveKey)?.ref ?? null : null; }
function retryDelayMs(attempts: number): number { return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1)); }
function retryable(detail?: string): boolean { return !/(invalid|forbidden|not supported|unknown artifact)/i.test(detail || ""); }
async function attachmentPaths(ids?: string[]): Promise<string[]> {
    const paths: string[] = [];
    for (const id of ids || []) { const artifact = await getArtifact(id); if (!artifact) throw new Error(`Unknown artifact: ${id}`); paths.push(artifact.path); }
    return paths;
}
async function tryDeliver(item: OutboundDelivery): Promise<DeliveryResult> {
    const target = targets.get(conversationKey(item.target)); if (!target) return { delivered: false, detail: "Delivery target is unavailable." };
    if ((item.artifacts?.length || 0) > 0 && (item.target.channel === "irc" || item.target.channel === "terminal")) return { delivered: false, detail: `Attachments are not supported by ${item.target.channel}.` };
    try { return await target.send(item.content, await attachmentPaths(item.artifacts)); } catch (error: any) { return { delivered: false, detail: error?.message || String(error) }; }
}
export async function enqueueDelivery(target: ConversationRef, content: string, artifacts?: string[], idempotencyKey?: string): Promise<OutboundDelivery> {
    const queue = await loadQueue(), key = idempotencyKey || crypto.randomUUID(), existing = queue.find((item) => item.idempotencyKey === key); if (existing) return existing;
    const now = new Date().toISOString(), item: OutboundDelivery = { id: crypto.randomUUID(), idempotencyKey: key, target, content, artifacts, status: "pending", attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now };
    queue.push(item); await saveQueue(queue); await logActivity({ type: "delivery.queued", target: conversationKey(target), detail: { id: item.id, artifacts } }); return item;
}
export async function drainDeliveryQueue(now = new Date()): Promise<void> {
    if (draining) return; draining = true;
    try { const queue = await loadQueue(); let changed = false;
        for (const item of queue) { if (item.status !== "pending" || new Date(item.nextAttemptAt) > now) continue;
            const result = await tryDeliver(item); item.attempts++; item.updatedAt = new Date().toISOString();
            if (result.delivered) { item.status = "delivered"; await logActivity({ type: "delivery.sent", target: conversationKey(item.target), detail: { id: item.id, attempts: item.attempts } }); }
            else if (!retryable(result.detail) || item.attempts >= MAX_ATTEMPTS) { item.status = "failed"; item.lastError = result.detail; await logActivity({ type: "delivery.failed", target: conversationKey(item.target), detail: { id: item.id, reason: result.detail } }); }
            else { item.lastError = result.detail; item.nextAttemptAt = new Date(Date.now() + retryDelayMs(item.attempts)).toISOString(); await logActivity({ type: "delivery.retry", target: conversationKey(item.target), detail: { id: item.id, attempts: item.attempts, reason: result.detail } }); } changed = true;
        } if (changed) await saveQueue(queue);
    } finally { draining = false; }
}
export function startDeliveryWorker(): ReturnType<typeof setInterval> { if (worker) clearInterval(worker); void drainDeliveryQueue(); worker = setInterval(() => void drainDeliveryQueue(), 1_000); return worker; }
export function stopDeliveryWorker(): void { if (worker) clearInterval(worker); worker = null; }
export async function deliver(ref: ConversationRef, content: string, artifacts?: string[]): Promise<DeliveryResult> { const item = await enqueueDelivery(ref, content, artifacts); await drainDeliveryQueue(); const updated = (await loadQueue()).find((candidate) => candidate.id === item.id); return updated?.status === "delivered" ? { delivered: true } : { delivered: false, detail: updated?.lastError || "Queued for retry." }; }
export async function deliverLastActive(content: string): Promise<DeliveryResult> { const ref = getLastDeliveryTarget(); return ref ? deliver(ref, content) : { delivered: false, detail: "No active delivery target." }; }
export async function listOutboundDeliveries(): Promise<OutboundDelivery[]> { return loadQueue(); }
