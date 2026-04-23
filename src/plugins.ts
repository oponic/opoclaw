import { resolve, sep } from "path";
import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { pathToFileURL } from "url";
import { getPluginDir, pluginsEnabled } from "./config.ts";
import { registerTool, unregisterTool, TOOLS } from "./tools.ts";
import type { HostInitMessage, PluginManifest, PluginWorkerMessage } from "./plugin_api.ts";
import { isOpenAIFunctionTool } from "./plugin_api.ts";

type PendingCall = {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
};

type LoadedPlugin = {
    manifest: PluginManifest;
    worker: Worker;
    active: boolean;
    root: string;
    tools: string[];
    callCounter: number;
    pending: Map<string, PendingCall>;
    shutdownAckResolver?: () => void;
};

const PLUGINS: Map<string, LoadedPlugin> = new Map();
const TOOL_OWNERS: Map<string, string> = new Map();
const BUILTIN_TOOL_IDS = new Set(Object.keys(TOOLS));

const READY_TIMEOUT_MS = 10_000;
const INVOKE_TIMEOUT_MS = 15_000;

export async function loadPlugins(config: any): Promise<void> {
    if (!pluginsEnabled(config)) return;
    const pluginRoot = getPluginDir(config);
    if (!existsSync(pluginRoot)) return;

    const entries = await readdir(pluginRoot, { withFileTypes: true });
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const root = resolve(pluginRoot, e.name);
        try {
            const mf = resolve(root, "plugin.json");
            if (!existsSync(mf)) continue;
            const manifest = await Bun.file(mf).json() as PluginManifest;
            if (!validateManifest(manifest, root)) {
                console.warn(`Invalid manifest for plugin at ${root}; skipping.`);
                continue;
            }
            if (!manifest?.name || PLUGINS.has(manifest.name)) continue;

            const entry = manifest.entry || "plugin.ts";
            const entryPath = resolve(root, entry);
            if (!isPathInsideRoot(root, entryPath)) {
                console.warn(`Plugin ${manifest.name} entry escapes plugin root; skipping.`);
                continue;
            }

            try {
                const loaded = await spawnPluginWorker(manifest, root, entryPath, config);
                PLUGINS.set(manifest.name, loaded);
                console.log(`Loaded plugin (worker): ${manifest.name}`);
            } catch (err: any) {
                console.warn(`Failed to spawn worker for plugin ${manifest.name}: ${err}`);
                continue;
            }
        } catch (err: any) {
            console.warn(`Failed loading plugin at ${root}: ${err?.message || err}`);
        }
    }
}

async function spawnPluginWorker(manifest: PluginManifest, root: string, entryPath: string, config: any): Promise<LoadedPlugin> {
    const runnerUrl = new URL("./plugin_worker_runner.ts", import.meta.url);
    const worker = new Worker(runnerUrl.toString(), { type: "module" } as any);
    const loaded: LoadedPlugin = {
        manifest,
        worker,
        active: false,
        root,
        tools: [],
        callCounter: 0,
        pending: new Map(),
    };

    const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
        let readyFinished = false;
        const rejectIfPending = (error: Error) => {
            if (readyFinished) return;
            readyFinished = true;
            rejectReady(error);
        };
        const resolveIfPending = () => {
            if (readyFinished) return;
            readyFinished = true;
            resolveReady();
        };

        const readyTimer = setTimeout(() => {
            rejectIfPending(new Error(`Plugin ${manifest.name} did not become ready in time.`));
        }, READY_TIMEOUT_MS);

        worker.onmessage = (ev: MessageEvent) => {
            const msg = ev.data as PluginWorkerMessage;
            if (!msg || typeof msg !== "object") return;

            if (msg.type === "ready") {
                clearTimeout(readyTimer);
                const ok = registerPluginTools(loaded, msg.tools ?? []);
                if (!ok) {
                    rejectIfPending(new Error(`Plugin ${manifest.name} has no valid tools.`));
                    return;
                }
                loaded.active = true;
                resolveIfPending();
                return;
            }

            if (msg.type === "invokeResult") {
                settlePendingCall(loaded.pending, msg.callId, msg.error ? new Error(msg.error) : undefined, msg.result);
                return;
            }

            if (msg.type === "log") {
                console.log(`[plugin:${manifest.name}]`, ...(msg.args || []));
                return;
            }

            if (msg.type === "shutdownAck") {
                if (loaded.shutdownAckResolver) {
                    loaded.shutdownAckResolver();
                    loaded.shutdownAckResolver = undefined;
                }
                return;
            }

            if (msg.type === "error" || msg.type === "fatal") {
                console.warn(`Plugin worker ${manifest.name} error: ${msg.message || "unknown"}`);
                if (msg.type === "fatal") {
                    if (!loaded.active) {
                        clearTimeout(readyTimer);
                        rejectIfPending(new Error(`Plugin ${manifest.name} reported fatal error before ready: ${msg.message || "unknown"}`));
                    } else {
                        void unloadPlugin(manifest.name);
                    }
                }
                return;
            }
        };

        worker.onerror = (event: ErrorEvent) => {
            clearTimeout(readyTimer);
            rejectIfPending(new Error(event.message || `Worker error for plugin ${manifest.name}`));
        };

        worker.onmessageerror = () => {
            clearTimeout(readyTimer);
            rejectIfPending(new Error(`Worker message error for plugin ${manifest.name}`));
        };

        const initMessage: HostInitMessage = {
            type: "init",
            entry: pathToFileURL(entryPath).toString(),
            manifest,
            root,
            workspaceRoot: resolve(root, ".."),
            config: config ?? {},
        };
        worker.postMessage(initMessage);
    });

    try {
        await readyPromise;
        return loaded;
    } catch (err) {
        try {
            worker.terminate();
        } catch {
        }
        for (const id of loaded.tools) {
            unregisterTool(id);
            TOOL_OWNERS.delete(id);
        }
        throw err;
    }
}

function validateManifest(manifest: any, root: string): boolean {
    if (!manifest || typeof manifest !== 'object') return false;
    if (!manifest.name || typeof manifest.name !== 'string') return false;
    if (manifest.entry && typeof manifest.entry !== 'string') return false;
    // hard-remove legacy plugin API fields
    if (manifest.permissions !== undefined) return false;
    if (manifest.mounts !== undefined) return false;
    if (manifest.hooks !== undefined) return false;
    // basic safety: ensure entry does not escape plugin root
    if (manifest.entry) {
        if (manifest.entry.includes('..')) return false;
        const entryPath = resolve(root, manifest.entry);
        if (!isPathInsideRoot(root, entryPath)) return false;
    }
    return true;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
    const normalizedRoot = resolve(root);
    const normalizedCandidate = resolve(candidate);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + sep);
}

function registerPluginTools(plugin: LoadedPlugin, rawTools: unknown[]): boolean {
    let registered = 0;

    for (const rawTool of rawTools) {
        if (!isOpenAIFunctionTool(rawTool)) continue;
        const tool = rawTool;
        const id = tool.function.name;

        if (BUILTIN_TOOL_IDS.has(id)) {
            console.warn(`Plugin ${plugin.manifest.name} attempted to override built-in tool ${id}; skipped.`);
            continue;
        }
        if (TOOL_OWNERS.has(id)) {
            console.warn(`Plugin ${plugin.manifest.name} attempted to register duplicate tool ${id}; skipped.`);
            continue;
        }

        plugin.tools.push(id);
        TOOL_OWNERS.set(id, plugin.manifest.name);
        registerTool(
            id,
            tool,
            async (args: Record<string, any>) => {
                const result = await invokePluginTool(plugin, id, args);
                return String(result ?? "");
            },
            plugin.manifest.name,
        );
        registered += 1;
    }

    return registered > 0;
}

async function invokePluginTool(plugin: LoadedPlugin, toolName: string, args: Record<string, any>): Promise<unknown> {
    if (!plugin.active) throw new Error(`Plugin ${plugin.manifest.name} is not active`);

    const callId = `${plugin.manifest.name}:${++plugin.callCounter}`;
    return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
            plugin.pending.delete(callId);
            reject(new Error(`Plugin ${plugin.manifest.name} timed out while executing ${toolName}`));
        }, INVOKE_TIMEOUT_MS);

        plugin.pending.set(callId, { resolve, reject, timer });
        plugin.worker.postMessage({
            type: "invoke",
            callId,
            toolName,
            args,
        });
    });
}

function settlePendingCall(pending: Map<string, PendingCall>, callId: string, error?: Error, result?: unknown): void {
    const entry = pending.get(callId);
    if (!entry) return;
    pending.delete(callId);
    clearTimeout(entry.timer);
    if (error) {
        entry.reject(error);
        return;
    }
    entry.resolve(result);
}

export function listLoadedPlugins(): string[] {
    return Array.from(PLUGINS.keys());
}

export async function unloadPlugin(name: string): Promise<void> {
    const p = PLUGINS.get(name);
    if (!p) return;
    try {
        const shutdownAckPromise = new Promise<void>((resolveAck) => {
            p.shutdownAckResolver = resolveAck;
        });

        p.worker.postMessage({ type: "shutdown" });
        await Promise.race([
            shutdownAckPromise,
            new Promise((resolve) => setTimeout(resolve, 500)),
        ]);

        p.worker.terminate();
    } catch (err) {
        console.warn(`Error during plugin ${name} deactivate: ${err}`);
    } finally {
        p.shutdownAckResolver = undefined;
    }

    for (const [callId, pendingCall] of p.pending.entries()) {
        p.pending.delete(callId);
        clearTimeout(pendingCall.timer);
        pendingCall.reject(new Error(`Plugin ${name} unloaded before call ${callId} completed`));
    }

    // clean up registered tools by this plugin
    if (p.tools.length > 0) {
        for (const id of p.tools) {
            unregisterTool(id);
            TOOL_OWNERS.delete(id);
        }
    }

    p.active = false;
    PLUGINS.delete(name);
}
