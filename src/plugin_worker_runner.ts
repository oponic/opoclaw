// Worker runner for plugins. The main thread should pass entry file via ?entry=file:///abs/path
const params = new URL(import.meta.url).searchParams;
const entry = params.get("entry");

if (!entry) {
    throw new Error("Plugin worker requires ?entry=file:///... query param");
}

const config = JSON.parse(params.get('config') || '{}');
const root = params.get('root') || '';
const manifest = JSON.parse(params.get('manifest') || '{}');

const pendingPromises: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }> = new Map();

async function main() {
    let mod: any = null;
    try {
        mod = await import(entry as string);
    } catch (err) {
        (globalThis as any).postMessage({ type: 'error', message: String(err) });
        throw err;
    }

    const ctx = {
        config,
        manifest,
        root,
        registerTool: (descriptor: any) => {
            (globalThis as any).postMessage({ type: 'registerTool', descriptor });
        },
        unregisterTool: (id: any) => {
            (globalThis as any).postMessage({ type: 'unregisterTool', id });
        },
        readFile: async (rel: string): Promise<string | null> => {
            const callId = crypto.randomUUID();
            (globalThis as any).postMessage({ type: 'readFile', callId, rel });
            return new Promise((resolve, reject) => {
                pendingPromises.set(callId, { resolve: (v: any) => resolve(v), reject });
            });
        },
        editFile: async (rel: string, content: string): Promise<boolean> => {
            const callId = crypto.randomUUID();
            (globalThis as any).postMessage({ type: 'editFile', callId, rel, content });
            return new Promise((resolve, reject) => {
                pendingPromises.set(callId, { resolve: (v: any) => resolve(v), reject });
            });
        },
        log: (...args: any[]) => {
            (globalThis as any).postMessage({ type: 'log', args });
        },
        checkPermission: (p: string) => {
            const permsAny: Record<string, any> = (manifest.permissions as Record<string, any>) || {};
            if (!p) return false;
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
    } as any;

    (globalThis as any).onmessage = async (ev: any) => {
        const msg = ev.data;
        if (!msg || !msg.type) return;

        if (msg.type === 'readFileResult') {
            const p = pendingPromises.get(msg.callId);
            if (p) {
                pendingPromises.delete(msg.callId);
                p.resolve(msg.content);
            }
        } else if (msg.type === 'editFileResult') {
            const p = pendingPromises.get(msg.callId);
            if (p) {
                pendingPromises.delete(msg.callId);
                p.resolve(msg.ok);
            }
        } else if (msg.type === 'invokeTool') {
            const { callId, name, args } = msg;
            try {
                if (typeof mod.handleToolCall === 'function') {
                    const res = await mod.handleToolCall(name, args, config);
                    (globalThis as any).postMessage({ type: 'invokeResult', callId, result: res });
                } else if (typeof mod.invoke === 'function') {
                    const res = await mod.invoke(name, args, config);
                    (globalThis as any).postMessage({ type: 'invokeResult', callId, result: res });
                } else {
                    (globalThis as any).postMessage({ type: 'invokeResult', callId, error: 'Plugin has no invoke handler' });
                }
            } catch (err: any) {
                (globalThis as any).postMessage({ type: 'invokeResult', callId, error: String(err) });
            }
        } else if (msg.type === 'deactivate' && activated && typeof mod.deactivate === 'function') {
            try {
                await mod.deactivate();
            } catch (err: any) {
                (globalThis as any).postMessage({ type: 'error', message: String(err) });
            }
        }
    };

    let activated = false;
    try {
        if (mod && typeof mod.activate === 'function') {
            await mod.activate(ctx);
        }
        activated = true;
        (globalThis as any).postMessage({ type: 'ready' });
    } catch (err: any) {
        (globalThis as any).postMessage({ type: 'error', message: String(err) });
        throw err;
    }
}

main().catch((err) => {
    try { (globalThis as any).postMessage({ type: 'fatal', message: String(err) }); } catch {}
    throw err;
});
