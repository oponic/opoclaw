import { resolve } from "path";
import { unlinkSync, writeFileSync } from "fs";
import { startDiscord } from "./discord.ts";
import { startIRC } from "./irc.ts";
import { startOpenAI } from "./openai.ts";
import { AgentSession, summarizeToolBatch, type ToolCall } from "../agent.ts";
import { loadConfig } from "../config.ts";
import { requiresToolApproval } from "../tools/index.ts";
import { isHibernating, setHibernating, buildSystemPrompt, OP_DIR } from "./shared.ts";

const LOCK_FILE = resolve(OP_DIR, ".gateway.lock");
const CORE_HOST = "127.0.0.1";
const CORE_PORT = 6112;
const coreChatSessions = new Map<string, AgentSession>();

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


export type CoreChatCallbacks = {
    approveTool?: (call: ToolCall, args: Record<string, any>) => Promise<boolean>;
    requestPermission?: (message: string, title?: string) => Promise<boolean>;
    askQuestion?: (question: string, options: string[], title?: string) => Promise<{ selected: string; userLabel?: string } | null>;
    onToolLine?: (line: string) => void;
};

export async function runCoreChatTurn(
    sessionKey: string,
    userText: string,
    callbacks: CoreChatCallbacks = {},
): Promise<{ text: string; reasoningSummary?: string }> {
    const config = loadConfig();
    const toolCallSummaries = config.tool_call_summaries ?? "full";
    let session = coreChatSessions.get(sessionKey);
    if (!session) {
        session = new AgentSession(`opoclaw-core-${sessionKey}-${Date.now()}`);
        coreChatSessions.set(sessionKey, session);
    }

    if (await isHibernating()) {
        const approved = callbacks.requestPermission
            ? await callbacks.requestPermission("The gateway is hibernating. Wake it and continue?", "Wake Gateway?")
            : false;
        if (!approved) {
            return { text: "Gateway is hibernating. Approve wake-up to continue." };
        }
        await setHibernating(false);
    }

    session.addMessage({ role: "user", content: userText });
    const systemPrompt = await buildSystemPrompt(config, [], "terminal");

    const onToolCall = (call: ToolCall) => {
        if (toolCallSummaries === "off") return;
        if (call.function.name === "deep_research") {
            callbacks.onToolLine?.("Using Deep Research...");
            return;
        }
        if (call.function.name === "request_permission" || call.function.name === "question" || call.function.name === "poll") {
            return;
        }
        if (requiresToolApproval(call.function.name)) {
            return;
        }
        if (toolCallSummaries === "minimal") return;
        callbacks.onToolLine?.(`Tool: ${call.function.name}`);
    };

    const onToolCallError = (_id: string, error: Error) => {
        if (toolCallSummaries === "off") return;
        callbacks.onToolLine?.(`Tool error: ${error.message}`);
    };

    const onToolBatch = async (calls: ToolCall[], results: any[], sessionId: string) => {
        if (toolCallSummaries !== "minimal") return;
        const summary = await summarizeToolBatch(calls, results, config, sessionId);
        const trimmed = summary.trim();
        if (trimmed && trimmed !== "(no summary)") callbacks.onToolLine?.(trimmed);
    };

    const requestToolApproval = async (call: ToolCall, _uniqueId: string) => {
        if (!requiresToolApproval(call.function.name)) return { approved: true };
        let args: Record<string, any> = {};
        try {
            args = JSON.parse(call.function.arguments || "{}");
        } catch {
        }
        const approved = callbacks.approveTool ? await callbacks.approveTool(call, args) : false;
        return approved ? { approved: true } : { approved: false, message: "Not authorized to perform this action." };
    };

    const executeTool = async (call: ToolCall, args: Record<string, any>): Promise<string | undefined> => {
        if (call.function.name === "request_permission") {
            const approved = callbacks.requestPermission
                ? await callbacks.requestPermission(String(args.message || ""), typeof args.title === "string" ? args.title : undefined)
                : false;
            return approved ? "Approved." : "Denied.";
        }
        if (call.function.name === "question") {
            const question = String(args.question || "");
            const options = Array.isArray(args.options) ? args.options.map(String) : [];
            if (options.length < 2 || options.length > 10) {
                return "Error: question requires between 2 and 10 options.";
            }
            const selected = callbacks.askQuestion
                ? await callbacks.askQuestion(question, options, typeof args.title === "string" ? args.title : undefined)
                : null;
            if (!selected) return "No selection (timed out or denied).";
            return `Selected: ${selected.selected}\nUser: ${selected.userLabel || "local-user"}`;
        }
        if (call.function.name === "poll") {
            const question = String(args.question || "");
            const options = Array.isArray(args.options) ? args.options.map(String) : [];
            if (options.length < 2 || options.length > 10) {
                return "Error: poll requires between 2 and 10 options.";
            }
            const selected = callbacks.askQuestion
                ? await callbacks.askQuestion(question, options, typeof args.title === "string" ? args.title : "Poll")
                : null;
            if (!selected) return "Poll closed without selection.";
            return `Poll result (single-user TUI): ${selected.selected}`;
        }
        return undefined;
    };

    const result = await session.evaluate(systemPrompt, config, {
        onFirstToken: () => {},
        onToolCall,
        onToolCallError,
        requestToolApproval,
        onToolBatch,
        onDeepResearchSummary: async (summary: string) => {
            const trimmed = summary.trim();
            if (trimmed) callbacks.onToolLine?.(trimmed);
        },
        executeTool,
    });

    return { text: result.text, reasoningSummary: result.reasoningSummary };
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
        const out = await runCoreChatTurn(sessionKey, message, {});
        return json({ ok: true, ...out });
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
