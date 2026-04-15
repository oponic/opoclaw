// Worker runner for plugins. The main thread should pass entry file via ?entry=file:///abs/path
const params = new URL(import.meta.url).searchParams;
const entry = params.get("entry");

if (!entry) {
    throw new Error("Plugin worker requires ?entry=file:///... query param");
}

async function main() {
    let mod: any = null;
    try {
        mod = await import(entry);
    } catch (err) {
        (globalThis as any).postMessage({ type: 'error', message: String(err) });
        throw err;
    }

    const ctx = {
        manifest: {},
        registerTool: (descriptor: any) => {
            (globalThis as any).postMessage({ type: 'registerTool', descriptor });
        },
        registerSkill: (meta: any) => {
            (globalThis as any).postMessage({ type: 'registerSkill', meta });
        },
        log: (...args: any[]) => {
            (globalThis as any).postMessage({ type: 'log', args });
        },
    } as any;

    // Listen for invoke requests from the parent
    (globalThis as any).onmessage = async (ev: any) => {
        const msg = ev.data;
        if (!msg || !msg.type) return;
        if (msg.type === 'invokeTool') {
            const { callId, name, args } = msg;
            try {
                if (typeof mod.handleToolCall === 'function') {
                    const res = await mod.handleToolCall(name, args);
                    (globalThis as any).postMessage({ type: 'invokeResult', callId, result: res });
                } else if (typeof mod.invoke === 'function') {
                    const res = await mod.invoke(name, args);
                    (globalThis as any).postMessage({ type: 'invokeResult', callId, result: res });
                } else {
                    (globalThis as any).postMessage({ type: 'invokeResult', callId, error: 'Plugin has no invoke handler' });
                }
            } catch (err: any) {
                (globalThis as any).postMessage({ type: 'invokeResult', callId, error: String(err) });
            }
        }
    };

    // Activate plugin if possible
    try {
        if (mod && typeof mod.activate === 'function') {
            await mod.activate(ctx);
        }
        (globalThis as any).postMessage({ type: 'ready' });
    } catch (err: any) {
        (globalThis as any).postMessage({ type: 'error', message: String(err) });
        throw err;
    }
}

main().catch((err) => {
    // ensure worker crashes are visible
    try { (globalThis as any).postMessage({ type: 'fatal', message: String(err) }); } catch {}
    throw err;
});
