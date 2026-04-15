import { resolve, join } from "path";
import { readdir, stat, readFile } from "fs/promises";
import { existsSync } from "fs";
import { getPluginDir, pluginsEnabled, pluginUseWorkers } from "./config.ts";
import { registerTool, unregisterTool } from "./tools.ts";
import { registerSkill, unregisterSkill } from "./skills.ts";
import { readFileAsync, editFile } from "./workspace.ts";

type PluginManifest = {
    name: string;
    version?: string;
    entry?: string;
    description?: string;
    permissions?: Record<string, any>;
    mounts?: Record<string, string>;
    hooks?: string[];
};

const PLUGINS: Map<string, { manifest: PluginManifest; module?: any; active: boolean; root: string }> = new Map();

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
            const raw = await readFile(mf, "utf-8");
            const manifest = JSON.parse(raw) as PluginManifest;
            if (!validateManifest(manifest, root)) {
                console.warn(`Invalid manifest for plugin at ${root}; skipping.`);
                continue;
            }
            if (!manifest?.name) continue;
            const entry = manifest.entry || "plugin.ts";
            const entryPath = resolve(root, entry);
            // dynamic import OR worker sandbox
            if (pluginUseWorkers(config)) {
                try {
                    // spawn worker runner with entry param
                    const runnerUrl = new URL('./plugin_worker_runner.ts', import.meta.url).toString();
                    const entryFileUrl = 'file://' + entryPath;
                    const workerUrl = runnerUrl + `?entry=${encodeURIComponent(entryFileUrl)}`;
                    const worker = new Worker(workerUrl, { type: 'module' } as any);

                    // RPC map for pending invokes
                    const pending: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }> = new Map();
                    let callCounter = 0;

                    worker.onmessage = (ev: any) => {
                        const m = ev.data;
                        if (!m || !m.type) return;
                        if (m.type === 'ready') {
                            console.log(`Plugin worker ready: ${manifest.name}`);
                        } else if (m.type === 'registerTool') {
                            const descriptor = m.descriptor;
                            const id = descriptor?.function?.name || descriptor?.id;
                            if (!id) return;
                            // register a handler that forwards calls to worker
                            registerTool(id, descriptor, async (args: any) => {
                                const callId = `${Date.now()}-${++callCounter}`;
                                const p = new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
                                worker.postMessage({ type: 'invokeTool', callId, name: id, args });
                                const res = await p;
                                return String(res ?? "");
                            }, manifest.name);
                        } else if (m.type === 'registerSkill') {
                            try { registerSkill(m.meta); } catch (e) { console.warn(e); }
                        } else if (m.type === 'invokeResult') {
                            const callId = m.callId;
                            const entry = pending.get(callId);
                            if (!entry) return;
                            pending.delete(callId);
                            if (m.error) entry.reject(new Error(m.error)); else entry.resolve(m.result);
                        } else if (m.type === 'log') {
                            console.log(`[plugin:${manifest.name}]`, ...(m.args||[]));
                        } else if (m.type === 'error' || m.type === 'fatal') {
                            console.warn(`Plugin worker ${manifest.name} error:`, m.message || m);
                        }
                    };

                    PLUGINS.set(manifest.name, { manifest, module: worker as any, active: true, root });
                    console.log(`Loaded plugin (worker): ${manifest.name}`);
                } catch (err: any) {
                    console.warn(`Failed to spawn worker for plugin ${manifest.name}: ${err}`);
                    continue;
                }
            } else {
                // direct import in-process
                let mod: any = null;
                try {
                    mod = await import(entryPath);
                } catch (err) {
                    try {
                        // try file:// URL import (Node/Bun ESM variation)
                        mod = await import('file://' + entryPath);
                    } catch (err2) {
                        console.warn(`Failed to import plugin ${manifest.name}: ${err}`);
                        continue;
                    }
                }

                const ctx = buildContextForPlugin(manifest, root, config);
                if (typeof mod.activate === "function") {
                    await mod.activate(ctx);
                }

                PLUGINS.set(manifest.name, { manifest, module: mod, active: true, root });
                console.log(`Loaded plugin: ${manifest.name}`);
            }
        } catch (err: any) {
            console.warn(`Failed loading plugin at ${root}: ${err?.message || err}`);
        }
    }
}

function buildContextForPlugin(manifest: PluginManifest, root: string, config: any) {
    const pluginId = manifest.name;

    return {
        config,
        manifest,
        root,
        registerTool: (descriptor: any, handler: any) => {
            // descriptor must include an id (function name)
            const id = descriptor?.function?.name || descriptor?.id;
            if (!id) throw new Error("Tool descriptor must include a function.name or id");
            // Enforce permission: plugin must declare ability to register/use this tool
            const toolPerms = manifest.permissions?.tools ?? [];
            const allowed = Array.isArray(toolPerms) ? toolPerms.includes(id) || toolPerms.includes("*") : Boolean(toolPerms);
            if (!allowed) throw new Error(`Plugin ${pluginId} not permitted to register tool ${id}`);
            registerTool(id, descriptor, async (args: any, cfg: any) => await handler(args), pluginId);
        },
        unregisterTool: (id: string) => unregisterTool(id),
        registerSkill: (meta: any) => registerSkill(meta),
        unregisterSkill: (name: string) => unregisterSkill(name),
        readFile: async (rel: string) => {
            // permission check
            const fsPerms = manifest.permissions?.fileSystem ?? [];
            const allowed = Array.isArray(fsPerms) ? fsPerms.includes("workspace") || fsPerms.includes("*") : Boolean(fsPerms);
            if (!allowed) throw new Error(`Plugin ${pluginId} lacks fileSystem:workspace permission`);
            return await readFileAsync(rel, config.mounts);
        },
        editFile: async (rel: string, content: string) => {
            const fsPerms = manifest.permissions?.fileSystem ?? [];
            const allowed = Array.isArray(fsPerms) ? fsPerms.includes("workspace") || fsPerms.includes("*") : Boolean(fsPerms);
            if (!allowed) throw new Error(`Plugin ${pluginId} lacks fileSystem:workspace permission`);
            return await editFile(rel, content, config.mounts);
        },
        log: (...args: any[]) => console.log(`[plugin:${pluginId}]`, ...args),
        checkPermission: (p: string) => {
            const permsAny: Record<string, any> = (manifest.permissions as Record<string, any>) || {};
            if (!p) return false;
            // support granular checks like 'tools:read_file' or 'fileSystem:workspace'
            const parts = String(p).split(":", 2);
            if (parts.length === 2) {
                const [k, v] = parts;
                const key = String(k);
                const val = permsAny[key];
                if (!val) return false;
                if (Array.isArray(val)) return (val as any[]).includes(v) || (val as any[]).includes("*");
                return Boolean(val);
            }
            return Boolean(permsAny[p] ?? permsAny["all"] ?? false);
        },
        getMounts: () => (config.mounts || {}),
    } as const;
}

function validateManifest(manifest: any, root: string): boolean {
    if (!manifest || typeof manifest !== 'object') return false;
    if (!manifest.name || typeof manifest.name !== 'string') return false;
    if (manifest.entry && typeof manifest.entry !== 'string') return false;
    // permissions should be object if present
    if (manifest.permissions && typeof manifest.permissions !== 'object') return false;
    // basic safety: ensure entry does not escape plugin root
    if (manifest.entry) {
        if (manifest.entry.includes('..')) return false;
    }
    return true;
}

export function listLoadedPlugins(): string[] {
    return Array.from(PLUGINS.keys());
}

export async function unloadPlugin(name: string): Promise<void> {
    const p = PLUGINS.get(name);
    if (!p) return;
    try {
        if (p.module && typeof p.module.deactivate === "function") {
            await p.module.deactivate();
        }
    } catch (err) {
        console.warn(`Error during plugin ${name} deactivate: ${err}`);
    }
    // best-effort cleanup: remove any registered tools/skills by this plugin
    // (We don't track them individually here; plugins should unregister themselves in deactivate)
    PLUGINS.delete(name);
}
