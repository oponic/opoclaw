import net from "net";
import tls from "tls";
import { runAgent, type Message as ChatMessage } from "../agent.ts";
import { loadConfig } from "../config.ts";
import { buildSystemPrompt } from "./shared.ts";

function splitIrcMessage(text: string, maxLen = 400): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf(" ", maxLen);
        if (cut <= 0) cut = maxLen;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function parseChannels(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/[ ,]+/)
        .map((c) => c.trim())
        .filter(Boolean);
}

export async function startIRC(): Promise<void> {
    const config = loadConfig();
    const ircCfg = config.channel?.irc;
    if (!ircCfg?.enabled) return;

    const server = ircCfg.server || "localhost";
    const tlsEnabled = ircCfg.tls ?? true;
    const port = ircCfg.port || (tlsEnabled ? 6697 : 6667);
    const nick = ircCfg.nick || "opoclaw";
    const username = ircCfg.username || "opoclaw";
    const realname = ircCfg.realname || "opoclaw";
    const password = ircCfg.password;
    const channels = parseChannels(ircCfg.channels);

    const socket = tlsEnabled
        ? tls.connect({ host: server, port, rejectUnauthorized: false })
        : net.connect({ host: server, port });

    const send = (line: string) => {
        socket.write(line + "\r\n");
    };

    socket.on("connect", () => {
        if (password) send(`PASS ${password}`);
        send(`NICK ${nick}`);
        send(`USER ${username} 0 * :${realname}`);
    });

    const historyByTarget = new Map<string, ChatMessage[]>();

    const pushHistory = (key: string, msg: ChatMessage) => {
        const arr = historyByTarget.get(key) || [];
        arr.push(msg);
        if (arr.length > 50) arr.splice(0, arr.length - 50);
        historyByTarget.set(key, arr);
    };

    socket.on("data", async (data) => {
        const lines = data.toString("utf-8").split("\r\n").filter(Boolean);
        for (const line of lines) {
            if (line.startsWith("PING ")) {
                send(line.replace("PING", "PONG"));
                continue;
            }

            const match = line.match(/^:([^!]+)!.*?\sPRIVMSG\s(\S+)\s:(.*)$/);
            if (!match) continue;

            const sender = match[1]!;
            const target = match[2]!;
            const text = match[3] || "";

            const isDirect = target.toLowerCase() === nick.toLowerCase();
            const mentionRegex = new RegExp(`(^|\b)${nick}(\b|:)`, "i");
            const isMention = mentionRegex.test(text);
            if (!isDirect && !isMention) {
                const key = target.startsWith("#") ? target : sender;
                pushHistory(key, { role: "user", content: `[${sender}]: ${text}` });
                continue;
            }

            const cleaned = text.replace(mentionRegex, "").trim();
            const key = target.startsWith("#") ? target : sender;
            const history = historyByTarget.get(key) || [];

            const systemPrompt = await buildSystemPrompt(config);

            const userText = cleaned || "(empty message)";
            const historyWithUser = history.concat([{ role: "user", content: `[${sender}]: ${userText}` }]);

            const { text: responseText } = await runAgent(historyWithUser, systemPrompt, config, {
                onFirstToken: () => {},
                onToolCall: () => {},
                onToolCallError: () => {}
            });

            pushHistory(key, { role: "user", content: `[${sender}]: ${userText}` });
            if (responseText && responseText.trim() !== "HEARTBEAT_OK") {
                pushHistory(key, { role: "assistant", content: responseText });
                const targetName = isDirect ? sender : target;
                for (const chunk of splitIrcMessage(responseText)) {
                    send(`PRIVMSG ${targetName} :${chunk}`);
                }
            }
        }
    });

    socket.on("error", (err) => {
        console.error("IRC error:", err.message);
    });

    socket.on("close", () => {
        console.log("IRC connection closed");
    });

    socket.on("ready", () => {
        for (const chan of channels) {
            send(`JOIN ${chan}`);
        }
    });
}
