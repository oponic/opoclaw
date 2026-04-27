import { resolve } from "path";
import { unlinkSync, writeFileSync, unlink } from "fs";
import { OP_DIR } from "../shared.ts";

const LOCK_FILE = resolve(OP_DIR, ".gateway.lock");
export const CORE_HOST = "127.0.0.1";
export const CORE_PORT = 6112;

export function clearGatewayPid(): void {
    try {
        unlinkSync(LOCK_FILE);
    } catch {
    }
}

export function setGatewayPid(pid: number): void {
    try {
        writeFileSync(LOCK_FILE, String(pid));
    } catch {
    }
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

import { loadConfig } from "../../config.ts";
import { isHibernating, setHibernating } from "../shared.ts";
import { type CoreChatCallbacks, runCoreChatTurn } from "./chat.ts";

export async function handleCoreRequest(req: Request, callbacks: CoreChatCallbacks = {}): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
        const config = loadConfig();
        return json({
            ok: true,
            pid: process.pid,
            hibernating: await isHibernating(),
            channels: {
                discord: !!config.channel?.discord?.enabled,
                irc: !!config.channel?.irc?.enabled,
                openai: !!config.channel?.openai?.enabled,
            },
        });
    }

    if (req.method === "POST" && url.pathname === "/control/hibernate") {
        await setHibernating(true);
        return json({ ok: true, hibernating: true });
    }

    if (req.method === "POST" && url.pathname === "/control/stop") {
        const response = json({ ok: true, stopping: true });
        setTimeout(() => {
            clearGatewayPid();
            process.exit(0);
        }, 50);
        return response;
    }

    if (req.method === "POST" && url.pathname === "/chat") {
        let body: any = {};
        try {
            body = await req.json();
        } catch {
            return json({ error: "Invalid JSON body." }, 400);
        }
        const sessionKey = String(body.session_id || "default");
        const message = String(body.message || "").trim();
        if (!message) {
            return json({ error: "Missing message." }, 400);
        }
        const out = await runCoreChatTurn(sessionKey, message, callbacks);
        return json({ ok: true, ...out });
    }

    return json({ error: "Not found" }, 404);
}