import type { HostInitMessage, OpenAIFunctionTool, PluginHostMessage, PluginInvokeContext, PluginModule } from "./plugin_api.ts";
import { isOpenAIFunctionTool } from "./plugin_api.ts";

function getExportedTools(mod: PluginModule): OpenAIFunctionTool[] {
    if (!Array.isArray(mod.tools)) return [];
    return mod.tools.filter(isOpenAIFunctionTool);
}

let pluginModule: PluginModule | null = null;
let pluginContext: PluginInvokeContext = {
    config: {},
    root: "",
    manifest: { name: "" },
};

async function initializePlugin(msg: HostInitMessage): Promise<void> {
    if (!msg.entry || typeof msg.entry !== "string") {
        throw new Error("Plugin worker init requires entry");
    }

    const mod = await import(msg.entry) as PluginModule;
    if (typeof mod.invoke !== "function") {
        throw new Error("Plugin must export invoke(toolName, args, context)");
    }

    pluginModule = mod;
    pluginContext = {
        config: msg.config ?? {},
        root: msg.root ?? "",
        manifest: msg.manifest ?? { name: "" },
    };

    (globalThis as any).postMessage({
        type: "ready",
        tools: getExportedTools(mod),
    });
}

(globalThis as any).onmessage = async (ev: MessageEvent<PluginHostMessage>) => {
    const msg = ev.data;
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
        if (!pluginModule || typeof pluginModule.deactivate !== "function") return;
        try {
            await pluginModule.deactivate();
        } catch (err: any) {
            (globalThis as any).postMessage({ type: "error", message: err?.message || String(err) });
        }
    }
};
