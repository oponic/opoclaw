import type { HostInitMessage, OpenAIFunctionTool, PluginHostMessage, PluginInvokeContext, PluginModule } from "./plugin_api.ts";
import { isOpenAIFunctionTool } from "./plugin_api.ts";
import { dirname, resolve } from "path";
import { editFile, listFiles, mkdirPath, readFileAsync, removePath } from "./workspace.ts";

function getExportedTools(mod: PluginModule): OpenAIFunctionTool[] {
    if (!Array.isArray(mod.tools)) return [];
    return mod.tools.filter(isOpenAIFunctionTool);
}

let pluginModule: PluginModule | null = null;
let pluginContext: PluginInvokeContext = {
    config: {},
    root: "",
    workspaceRoot: "",
    manifest: { name: "" },
    fs: {
        plugin: {
            readText: async () => "",
            readJson: async <T = unknown>() => ({} as T),
            writeText: async () => {},
            writeJson: async () => {},
            exists: async () => false,
            list: async () => [],
            mkdir: async () => {},
            remove: async () => {},
        },
        workspace: {
            readText: async () => "",
            readJson: async <T = unknown>() => ({} as T),
            writeText: async () => {},
            writeJson: async () => {},
            exists: async () => false,
            list: async () => [],
            mkdir: async () => {},
            remove: async () => {},
        },
    },
};

function createScopedFs(mountName: string, mounts: Record<string, string>) {
    const withMount = (relativePath: string): string => {
        const trimmed = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
        if (!trimmed) return `${mountName}/`;
        return `${mountName}/${trimmed}`;
    };

    const relativeFromMount = (fullPath: string): string | null => {
        const normalized = fullPath.replace(/\\/g, "/");
        const prefix = `${mountName}/`;
        if (!normalized.startsWith(prefix)) return null;
        return normalized.slice(prefix.length);
    };

    return {
        readText: async (relativePath: string): Promise<string> => {
            return await readFileAsync(withMount(relativePath), mounts);
        },
        readJson: async <T = unknown>(relativePath: string): Promise<T> => {
            const text = await readFileAsync(withMount(relativePath), mounts);
            return JSON.parse(text) as T;
        },
        writeText: async (relativePath: string, content: string): Promise<void> => {
            const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
            const parent = dirname(normalized);
            if (parent && parent !== ".") {
                mkdirPath(withMount(parent), mounts);
            }
            await editFile(withMount(relativePath), content, mounts);
        },
        writeJson: async (relativePath: string, value: unknown): Promise<void> => {
            const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
            const parent = dirname(normalized);
            if (parent && parent !== ".") {
                mkdirPath(withMount(parent), mounts);
            }
            await editFile(withMount(relativePath), JSON.stringify(value, null, 2), mounts);
        },
        exists: async (relativePath: string): Promise<boolean> => {
            try {
                await readFileAsync(withMount(relativePath), mounts);
                return true;
            } catch {
                try {
                    const all = await listFiles(mounts);
                    const target = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
                    const asDirPrefix = target ? `${mountName}/${target}/` : `${mountName}/`;
                    return all.some((p) => p.startsWith(asDirPrefix) || p === `${mountName}/${target}`);
                } catch {
                    return false;
                }
            }
        },
        list: async (relativePath = "."): Promise<string[]> => {
            const all = await listFiles(mounts);
            const requested = String(relativePath || ".").replace(/\\/g, "/").replace(/^\/+/, "");
            const prefix = requested === "." || requested === "" ? `${mountName}/` : `${mountName}/${requested}/`;
            const out = new Set<string>();
            for (const p of all) {
                const rel = relativeFromMount(p);
                if (rel === null) continue;
                if (requested !== "." && requested !== "" && !rel.startsWith(`${requested}/`) && rel !== requested) continue;
                const tail = requested === "." || requested === ""
                    ? rel
                    : rel.startsWith(`${requested}/`) ? rel.slice(requested.length + 1) : "";
                if (!tail) continue;
                const first = tail.split("/")[0];
                if (first) out.add(first);
            }
            return Array.from(out).sort();
        },
        mkdir: async (relativePath: string): Promise<void> => {
            mkdirPath(withMount(relativePath), mounts);
        },
        remove: async (relativePath: string, recursive = false): Promise<void> => {
            removePath(withMount(relativePath), recursive, mounts);
        },
    };
}

async function initializePlugin(msg: HostInitMessage): Promise<void> {
    if (!msg.entry || typeof msg.entry !== "string") {
        throw new Error("Plugin worker init requires entry");
    }

    const mod = await import(msg.entry) as PluginModule;
    if (typeof mod.invoke !== "function") {
        throw new Error("Plugin must export invoke(toolName, args, context)");
    }

    pluginModule = mod;
    const workerMounts: Record<string, string> = {
        __plugin__: msg.root ?? "",
        __workspace__: msg.workspaceRoot ?? resolve(msg.root ?? "", ".."),
    };

    pluginContext = {
        config: msg.config ?? {},
        root: msg.root ?? "",
        workspaceRoot: msg.workspaceRoot ?? resolve(msg.root ?? "", ".."),
        manifest: msg.manifest ?? { name: "" },
        fs: {
            plugin: createScopedFs("__plugin__", workerMounts),
            workspace: createScopedFs("__workspace__", workerMounts),
        },
    };

    (globalThis as any).postMessage({
        type: "ready",
        tools: getExportedTools(mod),
    });
}

(globalThis as any).onmessage = async (ev: MessageEvent) => {
    const msg = ev.data as PluginHostMessage;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "init") {
        try {
            await initializePlugin(msg);
        } catch (err: any) {
            (globalThis as any).postMessage({ type: "fatal", message: err?.message || String(err) });
        }
        return;
    }

    if (msg.type === "invoke") {
        if (!pluginModule || typeof pluginModule.invoke !== "function") {
            (globalThis as any).postMessage({ type: "invokeResult", callId: msg.callId, error: "Plugin is not initialized" });
            return;
        }

        try {
            const result = await pluginModule.invoke(msg.toolName, msg.args ?? {}, pluginContext);
            (globalThis as any).postMessage({ type: "invokeResult", callId: msg.callId, result });
        } catch (err: any) {
            (globalThis as any).postMessage({ type: "invokeResult", callId: msg.callId, error: err?.message || String(err) });
        }
        return;
    }

    if (msg.type === "shutdown") {
        if (!pluginModule || typeof pluginModule.deactivate !== "function") {
            (globalThis as any).postMessage({ type: "shutdownAck" });
            return;
        }
        try {
            await pluginModule.deactivate();
        } catch (err: any) {
            (globalThis as any).postMessage({ type: "error", message: err?.message || String(err) });
        } finally {
            (globalThis as any).postMessage({ type: "shutdownAck" });
        }
    }
};
