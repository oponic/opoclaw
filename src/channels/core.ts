import { resolve } from "path";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { startDiscord } from "./discord.ts";
import { startIRC } from "./irc.ts";
import { startOpenAI } from "./openai.ts";
import { loadConfig } from "../config.ts";

const OP_DIR = resolve(import.meta.dir, "../..");
const LOCK_FILE = resolve(OP_DIR, ".gateway.lock");
const HIBERNATE_FILE = resolve(OP_DIR, ".gateway.hibernate");
const CORE_HOST = "127.0.0.1";
const CORE_PORT = 6112;

function clearGatewayPid(): void {
    try {
        unlinkSync(LOCK_FILE);
    } catch {
    }
}

function setGatewayPid(pid: number): void {
    try {
        writeFileSync(LOCK_FILE, String(pid));
    } catch {
    }
}

async function isHibernating(): Promise<boolean> {
    return existsSync(HIBERNATE_FILE);
}

async function setHibernating(value: boolean): Promise<void> {
    if (value) {
        writeFileSync(HIBERNATE_FILE, new Date().toISOString());
        return;
    }
    try {
        unlinkSync(HIBERNATE_FILE);
    } catch {
    }
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

export async function handleCoreRequest(req: Request): Promise<Response> {
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

    return json({ error: "Not found" }, 404);
}

export async function startCore() {
    setGatewayPid(process.pid);

    const cleanup = () => clearGatewayPid();
    process.on("exit", cleanup);
    process.on("SIGTERM", () => {
        cleanup();
        process.exit(0);
    });
    process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
    });

    const server = Bun.serve({
        hostname: CORE_HOST,
        port: CORE_PORT,
        fetch: handleCoreRequest,
    });

    console.log(`[core] Control server listening on http://${CORE_HOST}:${server.port}`);

    try {
        await startDiscord();
    } catch (err: any) {
        console.error(`Discord channel failed to start: ${err.message}`);
        throw err;
    }

    try {
        await startIRC();
    } catch (err: any) {
        console.error(`IRC channel failed to start: ${err.message}`);
    }

    try {
        await startOpenAI();
    } catch (err: any) {
        console.error(`OpenAI channel failed to start: ${err.message}`);
        throw err;
    }

    return server;
}
