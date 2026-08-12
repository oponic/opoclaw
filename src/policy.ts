import { resolve } from "path";
import type { ToolDefinition } from "./tools/types.ts";
import { readJson, writeJson } from "./storage.ts";
import { logActivity } from "./activity.ts";

const SCOPES_FILE = resolve(import.meta.dir, "../data/policy-scopes.json");
export type Capability = "read" | "write" | "execute" | "network" | "schedule" | "message" | "config" | "admin";
export type ApprovalScope = "once" | "session" | "duration";
export type PolicyScope = { id: string; sessionId?: string; toolName: string; resource: string; expiresAt?: string; createdAt: string };
export type PolicyDecision = { allowed: boolean; requiresApproval: boolean; reason?: string; capabilities: Capability[]; resource: string };
const onceApprovals = new Set<string>();

export function capabilitiesForTool(tool: ToolDefinition): Capability[] { return tool.capabilities || (tool.requiresApproval ? ["admin"] : []); }
export function resourceForTool(tool: ToolDefinition, args: Record<string, any> = {}): string {
    const name = tool.schema.function.name;
    if (args.path) return `${name}:path:${args.path}`;
    if (args.url) { try { return `${name}:host:${new URL(args.url).host}`; } catch {} }
    if (args.key) return `${name}:config:${args.key}`;
    if (args.id) return `${name}:id:${args.id}`;
    if (args.schedule) return `${name}:schedule:${args.schedule}`;
    return `${name}:global`;
}
async function scopes(): Promise<PolicyScope[]> { return readJson(SCOPES_FILE, []); }
async function save(items: PolicyScope[]): Promise<void> { await writeJson(SCOPES_FILE, items); }
export async function cleanupExpiredScopes(): Promise<void> { const now = Date.now(); const items = await scopes(); const kept = items.filter((scope) => !scope.expiresAt || new Date(scope.expiresAt).getTime() > now); if (kept.length !== items.length) await save(kept); }
export async function getPolicyDecision(tool: ToolDefinition, sessionId: string, args: Record<string, any> = {}): Promise<PolicyDecision> {
    const capabilities = capabilitiesForTool(tool), resource = resourceForTool(tool, args), name = tool.schema.function.name;
    const once = onceApprovals.delete(`${sessionId}:${name}:${resource}`);
    if (once) return { allowed: true, requiresApproval: false, capabilities, resource };
    await cleanupExpiredScopes();
    const permitted = (await scopes()).some((scope) => scope.toolName === name && scope.resource === resource && (!scope.sessionId || scope.sessionId === sessionId));
    return { allowed: true, requiresApproval: !!tool.requiresApproval && !permitted, reason: tool.requiresApproval && !permitted ? `Approval required for ${capabilities.join(", ") || "sensitive"} capability on ${resource}.` : undefined, capabilities, resource };
}
export async function grantApproval(sessionId: string, toolName: string, scope: ApprovalScope = "once", resource = `${toolName}:global`, durationMs = 30 * 60_000): Promise<void> {
    if (scope === "once") { onceApprovals.add(`${sessionId}:${toolName}:${resource}`); return; }
    const items = await scopes(); items.push({ id: crypto.randomUUID(), sessionId: scope === "session" ? sessionId : undefined, toolName, resource, createdAt: new Date().toISOString(), expiresAt: scope === "duration" ? new Date(Date.now() + durationMs).toISOString() : undefined }); await save(items);
    await logActivity({ type: "policy.scope_granted", sessionId, tool: toolName, detail: { scope, resource } });
}
export async function clearSessionApprovals(sessionId: string): Promise<void> { await save((await scopes()).filter((scope) => scope.sessionId !== sessionId)); }
