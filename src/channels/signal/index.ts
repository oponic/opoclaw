import net from "net";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { AgentSession, summarizeToolBatch, type Message as ChatMessage, type ToolCall } from "../../agent.ts";
import { requiresToolApproval } from "../../tools/index.ts";
import { getFilePath } from "../../workspace.ts";
import { getVisionEnabled, getVideoEnabled, loadConfig, getActiveProvider, getModelId } from "../../config.ts";
import { isHibernating, setHibernating, buildSystemPrompt, OP_DIR } from "../shared.ts";
import { exec, getUpdateTag } from "../../utils.ts";
import { SignalRpc, type SignalEnvelope, type SignalReceive } from "../../signal/rpc.ts";
import { deliver, registerDeliveryTarget } from "../delivery.ts";

const VERSION = exec("git describe --tags --abbrev=0 2>/dev/null || echo ''", { cwd: OP_DIR });

const EYES = "👀";
const THINKING = "🤔";
const TOOL = "🔧";
const APPROVAL_TIMEOUT_MS = 60_000;

const DEFAULT_ATTACHMENTS_DIR = resolve(homedir(), ".local/share/signal-cli/attachments");
const DEFAULT_SOCKET_PATH = resolve(process.env.XDG_RUNTIME_DIR || "/tmp", "signal-cli/socket");

let daemonProcess: ReturnType<typeof Bun.spawn> | null = null;

/** True if something is already listening on the configured endpoint. */
async function endpointReachable(opts: { socket?: string; host?: string; port?: number }): Promise<boolean> {
    return new Promise((resolvePromise) => {
        const socket = opts.socket
            ? net.connect({ path: opts.socket })
            : net.connect({ host: opts.host || "127.0.0.1", port: opts.port || 7583 });
        const done = (value: boolean) => {
            socket.destroy();
            resolvePromise(value);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        setTimeout(() => done(false), 2000);
    });
}

/**
 * Start `signal-cli daemon` ourselves and wait for it to accept connections.
 * The gateway owns the daemon so `opoclaw gateway start` is all a user runs.
 */
async function startDaemon(cfg: {
    account: string;
    socket?: string;
    host?: string;
    port?: number;
    binary: string;
}): Promise<void> {
    const args = [cfg.binary, "-a", cfg.account, "daemon"];
    if (cfg.socket) {
        mkdirSync(dirname(cfg.socket), { recursive: true });
        // A stale socket file from a crashed daemon makes signal-cli refuse to bind.
        try {
            if (existsSync(cfg.socket)) unlinkSync(cfg.socket);
        } catch {
        }
        args.push("--socket", cfg.socket);
    } else {
        args.push("--tcp", `${cfg.host || "127.0.0.1"}:${cfg.port || 7583}`);
    }

    console.log(`[signal] Starting daemon: ${args.join(" ")}`);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
        proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (err: any) {
        throw new Error(
            `Failed to launch '${cfg.binary}': ${err.message}. Install signal-cli (https://github.com/AsamK/signal-cli) or set channel.signal.signal_cli_path.`,
        );
    }
    daemonProcess = proc;

    const pipe = async (stream: ReadableStream<Uint8Array> | null, prefix: string) => {
        if (!stream) return;
        const decoder = new TextDecoder();
        for await (const chunk of stream as any) {
            for (const line of decoder.decode(chunk).split("\n")) {
                if (line.trim()) console.log(`${prefix} ${line.trim()}`);
            }
        }
    };
    void pipe(proc.stdout as any, "[signal-cli]");
    void pipe(proc.stderr as any, "[signal-cli]");

    const stop = () => {
        if (daemonProcess) {
            try {
                daemonProcess.kill();
            } catch {
            }
            daemonProcess = null;
        }
    };
    process.on("exit", stop);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    // signal-cli needs a few seconds to boot the JVM and load the account.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) {
            throw new Error(
                `signal-cli daemon exited with code ${proc.exitCode}. Check that ${cfg.account} is registered or linked (\`signal-cli link -n "opoclaw"\`).`,
            );
        }
        if (await endpointReachable(cfg)) {
            console.log("[signal] Daemon is up.");
            return;
        }
        await Bun.sleep(500);
    }
    stop();
    throw new Error("signal-cli daemon did not start listening within 60s.");
}

export type SignalConversation = {
    /** Stable id used for sessions and prompt routing. */
    key: string;
    /** Base64 group id, for group conversations. */
    groupId?: string;
    /** Recipient number/uuid, for 1:1 conversations. */
    recipient?: string;
    label: string;
};

/** Everything the channel needs to talk back to Signal. */
export type SignalContext = {
    rpc: SignalRpc;
    selfId: string;
    send: (conv: SignalConversation, text: string, attachments?: string[]) => Promise<number | null>;
    react: (conv: SignalConversation, targetAuthor: string, targetTimestamp: number, emoji: string, remove?: boolean) => Promise<void>;
};

type IncomingMessage = {
    conversation: SignalConversation;
    envelope: SignalEnvelope;
    senderId: string;
    senderLabel: string;
    timestamp: number;
    text: string;
    attachments: { id: string; filename: string; contentType: string; size?: number; path: string }[];
    quote?: { timestamp: number; authorId: string; text: string };
    mentionsSelf: boolean;
};

const conversationSessions = new Map<string, AgentSession>();
const conversationHistory = new Map<string, ChatMessage[]>();

// One pending yes/no or multiple-choice prompt per conversation; the receive
// loop hands the next matching message to it instead of the agent.
type PendingPrompt = {
    authorizedId: string;
    resolve: (value: string | null) => void;
};
const pendingPrompts = new Map<string, PendingPrompt>();

let context: SignalContext | null = null;

// Tracks the last conversation the bot actively responded in, so out-of-band
// senders (e.g. the heartbeat agent) can reach the most recent conversation.
let lastActiveConversation: SignalConversation | null = null;

export function getLastSignalConversationId(): string | null {
    return lastActiveConversation?.key ?? null;
}

export async function sendToLastSignalConversation(content: string): Promise<boolean> {
    if (!lastActiveConversation || !context) return false;
    try {
        for (const chunk of splitMessage(content)) {
            if (chunk) await context.send(lastActiveConversation, chunk);
        }
        return true;
    } catch {
        return false;
    }
}

// ── Formatting ─────────────────────────────────────────────────────────────

function sanitizeModelOutput(text: string): string {
    // Signal has no subtext formatting, so drop any `-#` lines the model picked
    // up from the Discord-flavoured house style; only the reply itself is sent.
    return text
        .replace(/\[id:\d+\]\s*/g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("-#"))
        .join("\n")
        .trim();
}

function splitMessage(text: string, maxLen = 1990): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
        let end = i + maxLen;
        if (end < text.length) {
            const nl = text.lastIndexOf("\n", end);
            if (nl > i) end = nl + 1;
        }
        chunks.push(text.slice(i, end));
        i = end;
    }
    return chunks;
}

function conversationOf(env: SignalEnvelope, selfId: string): SignalConversation {
    const groupId = env.dataMessage?.groupInfo?.groupId;
    if (groupId) {
        return {
            key: `group:${groupId}`,
            groupId,
            label: env.dataMessage?.groupInfo?.groupName || `group ${groupId.slice(0, 8)}`,
        };
    }
    const source = env.sourceNumber || env.sourceUuid || env.source || selfId;
    return { key: `dm:${source}`, recipient: source, label: env.sourceName || source };
}

function senderIdOf(env: SignalEnvelope): string {
    return env.sourceNumber || env.sourceUuid || env.source || "unknown";
}

function formatAuthor(env: SignalEnvelope, selfId: string): string {
    const id = senderIdOf(env);
    let str = id;
    if (env.sourceName && env.sourceName !== id) str += ` (${env.sourceName})`;
    if (isSelf(id, selfId)) str += " (you)";
    return str;
}

function isSelf(id: string, selfId: string): boolean {
    return !!id && (id === selfId);
}

async function fileToDataUrl(path: string, contentType: string): Promise<string | null> {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        const buf = Buffer.from(await file.arrayBuffer());
        return `data:${contentType || "application/octet-stream"};base64,${buf.toString("base64")}`;
    } catch {
        return null;
    }
}

export async function formatSignalMessage(
    msg: IncomingMessage,
    selfId: string,
    imageAttachments?: { url: string }[],
    videoAttachments?: { url: string }[],
): Promise<ChatMessage | null> {
    let message_formatted = "";

    if (msg.quote) {
        message_formatted += "=== Referenced Message Metadata ===\n";
        message_formatted += "This message is a reply to the following message:\n";
        message_formatted += `Message ID: ${msg.quote.timestamp}\n`;
        message_formatted += `Author: ${msg.quote.authorId}${isSelf(msg.quote.authorId, selfId) ? " (you)" : ""}\n`;
        message_formatted += "=== Referenced Message Content ===\n";
        message_formatted += msg.quote.text;
        message_formatted += "\n";
    }

    message_formatted += "=== Metadata ===\n";
    message_formatted += `Message ID: ${msg.timestamp}\n`;
    message_formatted += `Author: ${formatAuthor(msg.envelope, selfId)}\n`;
    message_formatted += `Conversation: ${msg.conversation.label}${msg.conversation.groupId ? " (group)" : " (direct)"}\n`;
    const mentions = msg.envelope.dataMessage?.mentions ?? [];
    if (mentions.length > 0) {
        message_formatted += "Mentions:\n";
        for (const mention of mentions) {
            message_formatted += ` - ${mention.number || mention.uuid || mention.name || "unknown"}\n`;
        }
    }
    message_formatted += "=== Content ===\n";

    if (isSelf(msg.senderId, selfId)) {
        const cleanedText = msg.text
            .split("\n")
            .filter((line) => !line.trim().startsWith("-#"))
            .join("\n")
            .trim();
        if (!cleanedText) return null;
        message_formatted += cleanedText;
        return { role: "assistant", content: message_formatted };
    }

    message_formatted += msg.text;

    // List any attachments not inlined as image/video parts so the model knows
    // they exist and can read them off disk if it needs to.
    const inlinedIds = new Set<string>([
        ...(imageAttachments || []).map((a) => a.url),
        ...(videoAttachments || []).map((a) => a.url),
    ]);
    const otherAttachments = msg.attachments.filter((a) => !inlinedIds.has(a.path));
    if (otherAttachments.length > 0) {
        message_formatted += "\n=== Attachments ===\n";
        for (const a of otherAttachments) {
            const meta = [a.contentType || "unknown type"];
            if (typeof a.size === "number") meta.push(`${a.size} bytes`);
            message_formatted += `- ${a.filename || "file"} (${meta.join(", ")}): ${a.path}\n`;
        }
    }

    const hasImages = imageAttachments && imageAttachments.length > 0;
    const hasVideos = videoAttachments && videoAttachments.length > 0;
    if (hasImages || hasVideos) {
        const parts: any[] = [{ type: "text", text: message_formatted }];
        for (const img of imageAttachments || []) {
            parts.push({ type: "image_url", image_url: { url: img.url } });
        }
        for (const vid of videoAttachments || []) {
            parts.push({ type: "video_url", video_url: { url: vid.url } });
        }
        return { role: "user", content: parts };
    }
    return { role: "user", content: message_formatted };
}

function pushHistory(key: string, message: ChatMessage): void {
    const arr = conversationHistory.get(key) || [];
    arr.push(message);
    if (arr.length > 40) arr.splice(0, arr.length - 40);
    conversationHistory.set(key, arr);
}

// ── Prompts (Signal has no buttons, so prompts are reply-driven) ────────────

function parseYesNo(text: string): boolean | null {
    const t = text.trim().toLowerCase();
    if (["y", "yes", "approve", "approved", "ok", "okay", "allow", "👍"].includes(t)) return true;
    if (["n", "no", "deny", "denied", "reject", "cancel", "👎"].includes(t)) return false;
    return null;
}

/** Wait for the authorized user's next message in this conversation. */
function awaitReply(conversationKey: string, authorizedId: string, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<string | null> {
    const existing = pendingPrompts.get(conversationKey);
    if (existing) existing.resolve(null);

    return new Promise((resolvePromise) => {
        let settled = false;
        const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (pendingPrompts.get(conversationKey)?.resolve === finish) {
                pendingPrompts.delete(conversationKey);
            }
            resolvePromise(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        pendingPrompts.set(conversationKey, { authorizedId, resolve: finish });
    });
}

async function sendApproval(
    ctx: SignalContext,
    conv: SignalConversation,
    authorizedId: string,
    title: string,
    body: string,
): Promise<"once" | "session" | "duration" | null> {
    const text = [`*${title}*`, body, "", "Reply *yes* for once, *session* for this session, *30* for 30 minutes, or *no* to deny (60s)."]
        .filter(Boolean)
        .join("\n");
    await ctx.send(conv, text);
    const reply = (await awaitReply(conv.key, authorizedId))?.trim().toLowerCase();
    const scope = reply === "session" ? "session" : reply === "30" || reply === "duration" ? "duration" : parseYesNo(reply || "") === true ? "once" : null;
    await ctx.send(conv, `Permission ${scope ? `granted (${scope})` : "denied"}.`);
    return scope;
}

async function askQuestion(
    ctx: SignalContext,
    conv: SignalConversation,
    authorizedId: string,
    title: string,
    question: string,
    options: string[],
): Promise<string> {
    if (options.length < 2 || options.length > 10) return "Error: question requires between 2 and 10 options.";
    const lines = [`*${title}*`, question, "", ...options.map((option, index) => `${index + 1}. ${option}`), "", "Reply with a number (60s)."];
    await ctx.send(conv, lines.filter(Boolean).join("\n"));
    const reply = await awaitReply(conv.key, authorizedId);
    if (reply === null) return "No selection (timed out).";
    const index = Number.parseInt(reply.trim(), 10) - 1;
    const selected = Number.isInteger(index) ? options[index] : undefined;
    if (!selected) return "No selection (invalid response).";
    await ctx.send(conv, `Selected: ${selected}`);
    return `Selected: ${selected}\nUser: ${authorizedId}`;
}

// ── Message handling ───────────────────────────────────────────────────────

const ABOUT_TEXT = () => {
    const tag = VERSION.toLowerCase();
    let releaseBadge = "";
    if (tag.includes("alpha")) releaseBadge = "[alpha]";
    else if (tag.includes("beta")) releaseBadge = "[beta]";
    else if (tag.includes("rc")) releaseBadge = "[rc]";
    return [
        `opoclaw ${VERSION} ${releaseBadge}`.trim(),
        "Lightweight Bun AI agent framework",
        "https://github.com/oponic/opoclaw",
        "oponic + others, 2026",
    ].join("\n");
};

/** Slash-style commands, since Signal has no application commands. */
async function handleCommand(ctx: SignalContext, msg: IncomingMessage): Promise<boolean> {
    const text = msg.text.trim();
    if (!text.startsWith("/")) return false;
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const config = loadConfig();

    if (cmd === "about") {
        await ctx.send(msg.conversation, ABOUT_TEXT());
        return true;
    }
    if (cmd === "info") {
        const type = (rest[0] || "").toLowerCase();
        if (type === "model") {
            await ctx.send(msg.conversation, `*Model:* ${getModelId(config)}`);
        } else if (type === "provider") {
            await ctx.send(msg.conversation, `*Provider:* ${getActiveProvider(config)}`);
        } else {
            await ctx.send(msg.conversation, "Usage: /info model | /info provider");
        }
        return true;
    }
    return false;
}

async function onMessage(ctx: SignalContext, msg: IncomingMessage): Promise<void> {
    const config = loadConfig();
    const selfId = ctx.selfId;

    // Always ignore our own messages
    if (isSelf(msg.senderId, selfId)) return;

    const conv = msg.conversation;

    // A pending approval/question prompt consumes the authorized user's reply.
    const pending = pendingPrompts.get(conv.key);
    if (pending && (!pending.authorizedId || pending.authorizedId === msg.senderId)) {
        pending.resolve(msg.text);
        return;
    }

    if (await handleCommand(ctx, msg)) return;

    const isDirect = !conv.groupId;
    const isReplyToBot = !!msg.quote && isSelf(msg.quote.authorId, selfId);
    const shouldRespond = isDirect || msg.mentionsSelf || isReplyToBot;

    // Get or bootstrap session for this conversation
    let session = conversationSessions.get(conv.key);
    if (!session) {
        session = new AgentSession(`opoclaw-signal-${selfId}-${conv.key}-${Date.now()}`);
        session.deliveryTarget = { channel: "signal", conversationId: conv.key, label: conv.label };
        conversationSessions.set(conv.key, session);
        for (const m of conversationHistory.get(conv.key) || []) {
            await session.addMessage(m);
        }
    }

    // Track all messages for context, but only respond when addressed.
    if (!shouldRespond) {
        const formatted = await formatSignalMessage(msg, selfId);
        if (formatted) {
            pushHistory(conv.key, formatted);
            await session.addMessage(formatted);
        }
        return;
    }

    const authorizedUserId = config.authorized_user_id?.trim();

    if (await isHibernating()) {
        if (!authorizedUserId) {
            await ctx.send(conv, "Permission denied: authorized_user_id is not set in config.toml.");
            return;
        }
        const approved = await sendApproval(
            ctx,
            conv,
            authorizedUserId,
            "Wake Gateway?",
            "The gateway is hibernating. Approve to wake it and continue.",
        );
        if (!approved) return;
        await setHibernating(false);
    }

    await ctx.react(conv, msg.senderId, msg.timestamp, EYES).catch(() => {});

    lastActiveConversation = conv;
    registerDeliveryTarget(
        { channel: "signal", conversationId: conv.key, label: conv.label },
        async (content, artifacts) => {
            try { await ctx.send(conv, content, artifacts); return { delivered: true }; }
            catch (error: any) { return { delivered: false, detail: error?.message || String(error) }; }
        },
    );

    const extraSections = [
        `\n## Signal Context\nConversation: ${conv.label} (${conv.groupId ? `group id ${conv.groupId}` : `direct chat with ${conv.recipient}`})\n` +
        `Message IDs are Signal timestamps and appear as \`Message ID:\` in history entries. Use the \`react_message\` tool with \`channel_id\` (this conversation id: \`${conv.key}\`) and \`message_id\` to react.\n` +
        `Never include \`[id:...]\` in your replies; IDs are only for tool calls.\nThreads, embeds and buttons do not exist on Signal: prompts are plain text and answered by reply.`,
    ];
    const systemPrompt = await buildSystemPrompt(config, extraSections, "signal");

    // signal-cli writes attachments to disk; inline them as data URLs so the
    // model can see them without a public CDN URL.
    const visionEnabled = getVisionEnabled(config);
    const videoEnabled = getVideoEnabled(config);
    const imageAttachments: { url: string }[] = [];
    const videoAttachments: { url: string }[] = [];
    for (const att of msg.attachments) {
        const type = att.contentType || "";
        if (visionEnabled && type.startsWith("image/")) {
            const url = await fileToDataUrl(att.path, type);
            if (url) imageAttachments.push({ url });
        } else if (videoEnabled && type.startsWith("video/")) {
            const url = await fileToDataUrl(att.path, type);
            if (url) videoAttachments.push({ url });
        }
    }

    let swappedToThinking = false;
    let gotToolCall = false;

    const onFirstToken = async () => {
        if (swappedToThinking) return;
        swappedToThinking = true;
        await ctx.react(conv, msg.senderId, msg.timestamp, THINKING).catch(() => {});
        await ctx.react(conv, msg.senderId, msg.timestamp, EYES, true).catch(() => {});
    };

    const toolCallSummaries = config.tool_call_summaries ?? "full";
    // Signal has no small/secondary text, so status chatter (tool calls, tool
    // errors, reasoning summaries, update notices) goes to the gateway log
    // instead of the conversation. Only real replies are sent.
    const onToolCall = async (call: ToolCall, _uniqueId: string) => {
        if (call.function.name === "deep_research") {
            console.log("[signal] Using Deep Research...");
            return;
        }
        if (call.function.name === "request_permission" || call.function.name === "question" || call.function.name === "poll") {
            return;
        }
        if (requiresToolApproval(call.function.name)) {
            return;
        }
        if (!gotToolCall) {
            await ctx.react(conv, msg.senderId, msg.timestamp, TOOL).catch(() => {});
            gotToolCall = true;
        }
        if (toolCallSummaries === "off" || toolCallSummaries === "minimal") return;

        let fullText = "Called " + call.function.name;
        try {
            const args = JSON.parse(call.function.arguments);
            if (call.function.name === "use_skill" && typeof args.name === "string") {
                fullText = `Using skill ${args.name}`;
            }
            if (call.function.name !== "use_skill") {
                const argEntries = Object.entries(args);
                if (argEntries.length === 1) {
                    fullText += ` with ${argEntries[0]![1]}`;
                }
            }
            if (call.function.name === "shell" && args.command && args.description) {
                const lines = args.command.split("\n");
                let line = lines[0];
                if (line.length > 50) {
                    line = line.slice(0, 50) + "…";
                } else if (lines.length > 1) {
                    line += "…";
                }
                fullText = args.description + "  •  " + line;
            }
        } catch {
        }
        console.log(`[signal] ${fullText}`);
    };

    const onToolCallError = async (_uniqueId: string, error: Error) => {
        if (toolCallSummaries === "off") return;
        console.error(`[signal] Tool error: ${error.message}`);
    };

    // In minimal mode we accumulate every tool result across the whole turn and
    // emit a single high-level summary at the end.
    const accumulatedToolResults: any[] = [];
    const onToolBatch = async (_calls: ToolCall[], results: any[], _sessionId: string) => {
        if (toolCallSummaries !== "minimal") return;
        accumulatedToolResults.push(...results);
    };

    const onDeepResearchSummary = async (summary: string) => {
        const trimmed = summary.trim();
        if (!trimmed) return;
        console.log(`[signal] ${trimmed}`);
    };

    const requestToolApproval = async (call: ToolCall, _uniqueId: string, resource?: string) => {
        if (!requiresToolApproval(call.function.name)) {
            return { approved: true };
        }
        if (!authorizedUserId) {
            await ctx.send(conv, "Permission denied: authorized_user_id is not set in config.toml.");
            return { approved: false, message: "Not authorized to make this decision." };
        }

        let argsPreview = "(no args)";
        try {
            const args = JSON.parse(call.function.arguments || "{}");
            if (call.function.name === "edit_config") {
                const key = typeof args.key === "string" ? args.key : "(missing)";
                const value = typeof args.value === "string" ? args.value : String(args.value ?? "(missing)");
                argsPreview = `key: ${key}\nvalue: ${value.length > 200 ? value.slice(0, 200) + "…" : value}`;
            } else if (Object.keys(args).length > 0) {
                const raw = JSON.stringify(args);
                argsPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
            }
        } catch {
        }

        const scope = await sendApproval(
            ctx,
            conv,
            authorizedUserId,
            "Authorize Tool Call",
            `Tool: \`${call.function.name}\`\nResource: \`${resource || "current request"}\`\nArgs: ${argsPreview}\nChoose an approval scope.`,
        );
        if (!scope) {
            return { approved: false, message: "Not authorized to make this decision." };
        }
        return { approved: true, scope };
    };

    const executeTool = async (call: ToolCall, args: Record<string, any>): Promise<string | undefined> => {
        if (call.function.name === "request_permission") {
            if (!authorizedUserId) {
                await ctx.send(conv, "Permission denied: authorized_user_id is not set in config.toml.");
                return "Not authorized to make this decision.";
            }
            const message = typeof args.message === "string" ? args.message : "";
            const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Permission Request";
            const approved = await sendApproval(ctx, conv, authorizedUserId, title, message);
            return approved ? "Approved." : "Denied.";
        }

        if (call.function.name === "question") {
            const question = typeof args.question === "string" ? args.question : "";
            const options = Array.isArray(args.options) ? args.options.map(String) : [];
            const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Question";
            return askQuestion(ctx, conv, authorizedUserId || msg.senderId, title, question, options);
        }

        if (call.function.name === "react_message") {
            const messageId = parseInt(String(args.message_id || ""), 10);
            const emoji = String(args.emoji || "");
            if (!Number.isFinite(messageId) || !emoji) {
                return "Error: react_message requires a numeric Signal 'message_id' (timestamp) and an 'emoji'.";
            }
            try {
                await ctx.react(conv, msg.senderId, messageId, emoji);
                return "Reaction added.";
            } catch (e: any) {
                return `Error adding reaction: ${e.message}`;
            }
        }

        if (call.function.name === "poll" || call.function.name === "check_polls") {
            return "Error: polls are not supported on Signal. Use the `question` tool instead.";
        }

        if (call.function.name === "create_thread") {
            return "Error: Signal has no threads.";
        }

        return undefined;
    };

    try {
        const formatted = await formatSignalMessage(
            msg,
            selfId,
            imageAttachments.length > 0 ? imageAttachments : undefined,
            videoAttachments.length > 0 ? videoAttachments : undefined,
        );
        if (formatted) pushHistory(conv.key, formatted);

        const { text: responseText, reasoningSummary } = await session.evaluatePrompt(
            formatted,
            systemPrompt,
            config,
            {
                onFirstToken,
                onToolCall,
                onToolCallError,
                requestToolApproval,
                onToolBatch,
                onDeepResearchSummary,
                onToolProgress: async (progress) => { await deliver(session.deliveryTarget!, progress); },
                onUsageAlert: async (threshold) => { await deliver(session.deliveryTarget!, `Usage alert: rolling 24-hour spending reached $${threshold.toFixed(2)}.`); },
                executeTool,
            },
        );

        if (toolCallSummaries === "minimal" && accumulatedToolResults.length > 0) {
            try {
                const summary = await summarizeToolBatch([], accumulatedToolResults, config, session.sessionId);
                const trimmed = summary.trim();
                if (trimmed && trimmed !== "(no summary)") {
                    console.log(`[signal] ${trimmed}`);
                }
            } catch (e: any) {
                console.error(`[signal] Tool summary failed: ${e.message}`);
            }
        }

        if (reasoningSummary?.trim()) {
            console.log(`[signal] ${reasoningSummary.trim()}`);
        }

        let finalResponse = sanitizeModelOutput(responseText);

        if (config.show_update_notification ?? true) {
            const updateTag = await getUpdateTag();
            if (updateTag) {
                console.log(`[signal] An update is available (${updateTag}). Run \`opoclaw update\` to update.`);
            }
        }

        if (!finalResponse.trim() || finalResponse.trim() === "HEARTBEAT_OK") {
            return;
        }

        pushHistory(conv.key, { role: "assistant", content: finalResponse });

        const chunks = splitMessage(finalResponse);
        let fileSent = false;

        for (let i = 0; i < chunks.length; i++) {
            const content = chunks[i];
            if (!content) continue;

            if (i === 0 && session.pendingFileSend && !fileSent) {
                try {
                    const filePath = getFilePath(session.pendingFileSend.path, config.mounts);
                    await ctx.send(conv, content, [filePath]);
                    fileSent = true;
                    session.pendingFileSend = null;
                } catch {
                    await ctx.send(conv, content);
                }
            } else {
                await ctx.send(conv, content);
            }
        }

        // Send remaining file if not yet sent (e.g., no text response)
        if (session.pendingFileSend && !fileSent) {
            try {
                const filePath = getFilePath(session.pendingFileSend.path, config.mounts);
                await ctx.send(conv, session.pendingFileSend.caption || "", [filePath]);
            } catch {
            }
            session.pendingFileSend = null;
        }
    } catch (err: any) {
        console.error("Agent error:", err);
        await ctx.send(conv, `⚠️ Error: ${err.message}`).catch(() => {});
    }

    if (swappedToThinking) {
        await ctx.react(conv, msg.senderId, msg.timestamp, THINKING, true).catch(() => {});
    }
    await ctx.react(conv, msg.senderId, msg.timestamp, EYES).catch(() => {});
}

// ── Envelope decoding ──────────────────────────────────────────────────────

function mentionsSelf(env: SignalEnvelope, selfId: string, selfUuid: string | undefined, botName: string): boolean {
    const mentions = env.dataMessage?.mentions ?? [];
    for (const m of mentions) {
        if (m.number && m.number === selfId) return true;
        if (selfUuid && m.uuid && m.uuid === selfUuid) return true;
    }
    const text = env.dataMessage?.message || "";
    if (!text) return false;
    if (selfId && text.includes(selfId)) return true;
    if (botName && new RegExp(`(^|\\W)@?${botName}(\\W|$)`, "i").test(text)) return true;
    return false;
}

function decode(env: SignalEnvelope, selfId: string, selfUuid: string | undefined, botName: string, attachmentsDir: string): IncomingMessage | null {
    const data = env.dataMessage;
    if (!data) return null;
    if (data.reaction) return null;

    const text = data.message || "";
    const attachments = (data.attachments || []).map((a) => ({
        id: a.id || "",
        filename: a.filename || a.id || "file",
        contentType: a.contentType || "",
        size: a.size,
        path: resolve(attachmentsDir, a.id || ""),
    }));
    if (!text.trim() && attachments.length === 0) return null;

    const conversation = conversationOf(env, selfId);
    const quote = data.quote?.id
        ? {
            timestamp: data.quote.id,
            authorId: data.quote.authorNumber || data.quote.author || data.quote.authorUuid || "",
            text: data.quote.text || "",
        }
        : undefined;

    return {
        conversation,
        envelope: env,
        senderId: senderIdOf(env),
        senderLabel: env.sourceName || senderIdOf(env),
        timestamp: data.timestamp || env.timestamp || Date.now(),
        text,
        attachments,
        quote,
        mentionsSelf: mentionsSelf(env, selfId, selfUuid, botName),
    };
}

// ── Startup ────────────────────────────────────────────────────────────────

export async function startSignal(): Promise<void> {
    const startupConfig = loadConfig();
    const signalCfg = startupConfig.channel?.signal;
    if (!signalCfg?.enabled) {
        return;
    }
    if (!signalCfg.account) {
        throw new Error("Signal account missing. Set channel.signal.account (e.g. \"+15551234567\") in config.toml.");
    }
    // A missing endpoint just means "use the default socket"; the gateway owns
    // the daemon lifecycle, so there is nothing for the user to configure.
    if (!signalCfg.socket && !signalCfg.host && !signalCfg.port) {
        signalCfg.socket = DEFAULT_SOCKET_PATH;
    }

    console.log(`[gateway] Active provider: ${getActiveProvider(startupConfig)}`);

    const selfId = signalCfg.account;
    const botName = signalCfg.bot_name || "opoclaw";
    const attachmentsDir = signalCfg.attachments_dir || DEFAULT_ATTACHMENTS_DIR;

    // Reuse a daemon that is already running (e.g. a system service); start our
    // own otherwise, unless the user opted out.
    const endpoint = { socket: signalCfg.socket, host: signalCfg.host, port: signalCfg.port };
    if (await endpointReachable(endpoint)) {
        console.log("[signal] Using the signal-cli daemon that is already running.");
    } else if (signalCfg.autostart ?? true) {
        await startDaemon({
            account: signalCfg.account,
            ...endpoint,
            binary: signalCfg.signal_cli_path || "signal-cli",
        });
    } else {
        throw new Error(
            "No signal-cli daemon is reachable and channel.signal.autostart is false. Start it yourself or enable autostart.",
        );
    }

    const rpc = new SignalRpc({
        socket: signalCfg.socket,
        host: signalCfg.host,
        port: signalCfg.port,
        account: signalCfg.account,
        onStatus: (line) => console.log(`[signal] ${line}`),
        onReceive: (receive) => {
            void handleReceive(receive);
        },
    });

    const send = async (conv: SignalConversation, text: string, attachments?: string[]): Promise<number | null> => {
        if (!text && (!attachments || attachments.length === 0)) return null;
        const params: Record<string, any> = { message: text };
        if (conv.groupId) params.groupId = conv.groupId;
        else if (conv.recipient) params.recipient = [conv.recipient];
        if (attachments?.length) params.attachments = attachments;
        try {
            const result = await rpc.request("send", params);
            return typeof result?.timestamp === "number" ? result.timestamp : null;
        } catch (err: any) {
            console.error(`[signal] send failed: ${err.message}`);
            return null;
        }
    };

    const react = async (
        conv: SignalConversation,
        targetAuthor: string,
        targetTimestamp: number,
        emoji: string,
        remove = false,
    ): Promise<void> => {
        const params: Record<string, any> = {
            emoji,
            targetAuthor,
            targetTimestamp,
            remove,
        };
        if (conv.groupId) params.groupId = conv.groupId;
        else if (conv.recipient) params.recipient = [conv.recipient];
        await rpc.request("sendReaction", params);
    };

    const ctx: SignalContext = { rpc, selfId, send, react };
    context = ctx;

    let selfUuid: string | undefined;

    const handleReceive = async (receive: SignalReceive) => {
        try {
            const env = receive.envelope;
            if (!env) return;
            const msg = decode(env, selfId, selfUuid, botName, attachmentsDir);
            if (!msg) return;
            await onMessage(ctx, msg);
        } catch (err: any) {
            console.error(`[signal] receive handler failed: ${err?.message || err}`);
        }
    };

    await rpc.connect();

    // Confirm the account is registered on this daemon and learn our own uuid
    // so group mentions of us can be detected.
    try {
        const accounts = await rpc.request("listAccounts", {});
        const list = Array.isArray(accounts) ? accounts : accounts?.accounts;
        const self = Array.isArray(list)
            ? list.find((a: any) => a?.number === selfId || a?.account === selfId)
            : null;
        selfUuid = self?.uuid;
        console.log(`[signal] Logged in as ${selfId}${selfUuid ? ` (${selfUuid})` : ""}`);
    } catch (err: any) {
        console.log(`[signal] Connected as ${selfId} (account listing unavailable: ${err.message})`);
    }
}
