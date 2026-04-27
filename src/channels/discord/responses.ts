import { AttachmentBuilder, type MessagePayload, type MessageReplyOptions } from "discord.js";
import { getFilePath } from "../../workspace.ts";
import { type OpoclawConfig } from "../../config.ts";

export function sanitizeModelOutput(text: string): string {
    return text.replace(/\[id:\d+\]\s*/g, "");
}

export function splitMessage(text: string, maxLen = 1990): string[] {
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

export async function sendResponse(
    msg: Message,
    finalResponse: string,
    session: any,
    config: OpoclawConfig,
): Promise<void> {
    const chunks = splitMessage(finalResponse);
    let fileSent = false;

    for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i];
        if (!content) continue;

        if (i === 0) {
            if (session.pendingFileSend && !fileSent) {
                try {
                    const filePath = getFilePath(session.pendingFileSend.path, config.mounts);
                    const attachment = new AttachmentBuilder(filePath, {
                        name: session.pendingFileSend.path.split("/").pop() || "file",
                    });
                    const replyOpts: MessageReplyOptions = {
                        content: content as string,
                        files: [attachment],
                    };
                    await msg.reply(replyOpts);
                    fileSent = true;
                    session.pendingFileSend = null;
                } catch (e: any) {
                    await msg.reply(content as string | MessagePayload | MessageReplyOptions);
                }
            } else {
                await msg.reply(content as string | MessagePayload | MessageReplyOptions);
            }
        } else {
            if ("send" in msg.channel) {
                await (msg.channel as any).send(content);
            }
        }
    }

    if (session.pendingFileSend && !fileSent) {
        try {
            const filePath = getFilePath(session.pendingFileSend.path, config.mounts);
            const attachment = new AttachmentBuilder(filePath, {
                name: session.pendingFileSend.path.split("/").pop() || "file",
            });
            if ("send" in msg.channel) {
                await (msg.channel as any).send({
                    content: session.pendingFileSend.caption || "",
                    files: [attachment],
                });
            }
        } catch { }
        session.pendingFileSend = null;
    }
}