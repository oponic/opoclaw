import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { AgentSession, type Message as AgentMessage, type ToolCall } from "../agent.ts";
import { getModelId, getSemanticSearchEnabled, getVisionEnabled, loadConfig, useTomlFiles, type OpoclawConfig } from "../config.ts";
import { requiresToolApproval } from "../tools.ts";
import { listSkills } from "../skills.ts";
import { readFileAsync } from "../workspace.ts";

const SYSTEM_PROMPT_FILE = resolve(import.meta.dir, "../SYSTEM.md");

type OpenAIContentPart =
    | { type: "text"; text?: string }
    | { type: "image_url"; image_url?: { url?: string } | string };

type OpenAIMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | OpenAIContentPart[] | null;
    tool_call_id?: string;
    name?: string;
};

type OpenAIChatCompletionRequest = {
    model?: string;
    messages?: OpenAIMessage[];
    stream?: boolean;
};

function loadSystemPromptBase(): string {
    try {
        return readFileSync(SYSTEM_PROMPT_FILE, "utf-8");
    } catch {
        return "";
    }
}

function renderSystemPrompt(template: string): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const date = now.toLocaleDateString("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "long",
        day: "2-digit",
    });
    const time = now.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    return template
        .replaceAll("{{DATE}}", date)
        .replaceAll("{{TIME}}", time)
        .replaceAll("{{TIMEZONE}}", tz);
}

async function buildSystemPrompt(config: OpoclawConfig, extraSystemMessages: string[] = []): Promise<string> {
    const useToml = useTomlFiles(config);
    const [agentsContent, soulContent, identityContent, memoryContent, skills] = await Promise.all([
        readFileAsync(useToml ? "agents.toml" : "AGENTS.md").catch(() => ""),
        readFileAsync(useToml ? "soul.toml" : "SOUL.md").catch(() => ""),
        readFileAsync(useToml ? "identity.toml" : "IDENTITY.md").catch(() => ""),
        readFileAsync(useToml ? "memory.toml" : "MEMORY.md").catch(() => ""),
        listSkills(),
    ]);

    const systemPromptParts: string[] = [];
    const base = loadSystemPromptBase();
    if (base) systemPromptParts.push(renderSystemPrompt(base));
    if (soulContent) systemPromptParts.push(soulContent);
    if (identityContent) {
        systemPromptParts.push(
            "\n## Your Identity\nThis is your " +
                (useToml ? "identity.toml" : "IDENTITY.md") +
                ".\n```\n" +
                identityContent +
                "\n```",
        );
    }
    if (agentsContent) systemPromptParts.push("\n## Operating Instructions\n" + agentsContent);
    if (memoryContent) {
        systemPromptParts.push(
            "\n## Memory\nThis is your " +
                (useToml ? "memory.toml" : "MEMORY.md") +
                ". You can edit that file, but be careful not to accidentally erase information in it.\n```\n" +
                memoryContent +
                "\n```",
        );
    }
    if (getSemanticSearchEnabled(config)) {
        systemPromptParts.push(
            "\n## Semantic Search\nYou have access to a semantic search command in your shell. Use `semantic-search <query>` and it'll return lines in any file that match embeddings. You don't need to worry about gaming this, remember it's semantic and not keyword based, so even just a description of what you're looking for can work. The command caches efficiently as well.\nThis is the recommended way to search through your memory. You can do multiple searches at once using normal shell syntax like semicolons: `semantic-search <query1>; semantic-search <query2>`",
        );
    }
    if (skills.length > 0) {
        systemPromptParts.push(
            `\n## Skills\nAvailable skills: ${skills.map((skill) => `\`${skill}\``).join(", ")}\nTo use a skill, call the use_skill tool with the skill name. It will return the skill's SKILL.md instructions before you apply them.`,
        );
    }
    if (useToml) {
        systemPromptParts.push(
            "\n## TOML Editing\nIn your shell, you have a convenient CLI for easy editing. You can use `toml <file> <key> push <value>` to push a value to a key, or `toml <file> <key> remove <value>` to remove a value. If the key or file doesn't exist, it will be created for you.\nThis is the primary way you should be managing memory. You can for example use `toml memory.toml notes push \"<something you want to remember>\"` to add a note to your memory, which will persist across sessions.",
        );
    }
    if (extraSystemMessages.length > 0) {
        systemPromptParts.push("\n## API Request Context\n" + extraSystemMessages.join("\n\n"));
    }

    return systemPromptParts.join("\n") || "You are a helpful assistant.";
}

function getBearerToken(req: Request): string {
    const auth = req.headers.get("authorization") || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || "";
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function sse(data: string, status = 200): Response {
    return new Response(data, {
        status,
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        },
    });
}

function toAgentContent(content: OpenAIMessage["content"], visionEnabled: boolean): AgentMessage["content"] {
    if (!Array.isArray(content)) {
        return content ?? "";
    }

    const parts: any[] = [];
    for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text") {
            parts.push({ type: "text", text: part.text || "" });
            continue;
        }
        if (part.type === "image_url" && visionEnabled) {
            const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
            if (url) {
                parts.push({ type: "image_url", image_url: { url } });
            }
        }
    }
    if (parts.length === 0) return "";
    return parts;
}

function toAgentMessages(messages: OpenAIMessage[] | undefined, config: OpoclawConfig): { history: AgentMessage[]; extraSystemMessages: string[] } {
    const history: AgentMessage[] = [];
    const extraSystemMessages: string[] = [];
    const visionEnabled = getVisionEnabled(config);

    for (const message of messages || []) {
        if (!message || typeof message !== "object") continue;
        if (message.role === "system") {
            if (typeof message.content === "string" && message.content.trim()) {
                extraSystemMessages.push(message.content.trim());
            } else if (Array.isArray(message.content)) {
                const text = message.content
                    .filter((part): part is Extract<OpenAIContentPart, { type: "text" }> => part?.type === "text")
                    .map((part) => part.text || "")
                    .join("\n")
                    .trim();
                if (text) extraSystemMessages.push(text);
            }
            continue;
        }

        history.push({
            role: message.role,
            content: toAgentContent(message.content, visionEnabled),
            tool_call_id: message.tool_call_id,
            name: message.name,
        });
    }

    return { history, extraSystemMessages };
}

function createChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null) {
    return {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                delta,
                finish_reason: finishReason,
            },
        ],
    };
}

export async function handleOpenAIRequest(req: Request, config = loadConfig()): Promise<Response> {
    const openaiCfg = config.channel?.openai;
    if (!openaiCfg?.enabled) {
        return json({ error: { message: "OpenAI channel is disabled.", type: "invalid_request_error" } }, 404);
    }

    const expectedApiKey = openaiCfg.api_key?.trim();
    if (expectedApiKey && getBearerToken(req) !== expectedApiKey) {
        return json({ error: { message: "Invalid API key.", type: "invalid_api_key" } }, 401);
    }

    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/v1/models") {
        const activeModel = getModelId(config);
        return json({
            object: "list",
            data: [
                { id: "opoclaw", object: "model", created: 0, owned_by: "opoclaw" },
                { id: activeModel, object: "model", created: 0, owned_by: "opoclaw" },
            ],
        });
    }

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return json({ error: { message: "Not found.", type: "invalid_request_error" } }, 404);
    }

    let body: OpenAIChatCompletionRequest;
    try {
        body = await req.json() as OpenAIChatCompletionRequest;
    } catch {
        return json({ error: { message: "Invalid JSON body.", type: "invalid_request_error" } }, 400);
    }

    const { history, extraSystemMessages } = toAgentMessages(body.messages, config);
    const systemPrompt = await buildSystemPrompt(config, extraSystemMessages);
    const session = new AgentSession(`opoclaw-openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    for (const message of history) {
        session.addMessage(message);
    }

    const deniedApprovalMessage = "This tool requires interactive approval and is not available through the OpenAI channel.";
    const result = await session.evaluate(systemPrompt, config, {
        onFirstToken: () => {},
        onToolCall: (_call: ToolCall, _uniqueId: string) => {},
        onToolCallError: (_uniqueId: string, _error: Error) => {},
        requestToolApproval: async (call) => {
            if (requiresToolApproval(call.function.name)) {
                return { approved: false, message: deniedApprovalMessage };
            }
            return { approved: true };
        },
    });

    const model = body.model || "opoclaw";
    const completionId = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
    const content = result.text || "";

    if (body.stream) {
        const payload =
            `data: ${JSON.stringify(createChunk(completionId, model, { role: "assistant" }, null))}\n\n` +
            `data: ${JSON.stringify(createChunk(completionId, model, { content }, "stop"))}\n\n` +
            "data: [DONE]\n\n";
        return sse(payload);
    }

    return json({
        id: completionId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content,
                },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    });
}

export async function startOpenAI() {
    const config = loadConfig();
    const openaiCfg = config.channel?.openai;
    if (!openaiCfg?.enabled) {
        return null;
    }

    const host = openaiCfg.host || "127.0.0.1";
    const port = openaiCfg.port || 6113;
    const server = Bun.serve({
        hostname: host,
        port,
        fetch: (req) => handleOpenAIRequest(req, config),
    });

    console.log(`[openai] Listening on http://${host}:${server.port}`);
    return server;
}
