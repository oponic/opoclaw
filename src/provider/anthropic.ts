import { getApiBaseUrl, getApiKey, getModelId, type OpoclawConfig } from "../config.ts";
import type { Message, ToolCall, CompletionResult } from "./types.ts";

function buildAnthropicMessages(messages: Message[]): { system: string; messages: any[] } {
    let system = "";
    const out: any[] = [];

    for (const m of messages) {
        if (m.role === "system") {
            if (typeof m.content === "string") {
                system += (system ? "\n" : "") + m.content;
            }
            continue;
        }

        if (m.role === "tool") {
            out.push({
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: m.tool_call_id,
                        content: m.content ?? "",
                    },
                ],
            });
            continue;
        }

        if (m.role === "assistant") {
            const contentBlocks: any[] = [];
            if (m.content) {
                contentBlocks.push({ type: "text", text: m.content });
            }
            if (m.tool_calls && m.tool_calls.length > 0) {
                for (const tc of m.tool_calls) {
                    let input: any = {};
                    try {
                        input = JSON.parse(tc.function.arguments || "{}");
                    } catch {
                        input = {};
                    }
                    contentBlocks.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input,
                    });
                }
            }
            out.push({ role: "assistant", content: contentBlocks });
            continue;
        }

        if (m.role === "user") {
            if (Array.isArray(m.content)) {
                const blocks: any[] = [];
                for (const part of m.content) {
                    if (part?.type === "text") {
                        blocks.push({ type: "text", text: part.text || "" });
                    } else if (part?.type === "image_url" && part.image_url?.url) {
                        blocks.push({ type: "image", source: { type: "url", url: part.image_url.url } });
                    }
                }
                out.push({ role: "user", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
            } else {
                out.push({
                    role: "user",
                    content: [{ type: "text", text: m.content ?? "" }],
                });
            }
        }
    }

    return { system, messages: out };
}

export async function generateCompletion(
    messages: Message[],
    config: OpoclawConfig,
    onFirstToken: () => void,
    toolsOverride?: any[],
): Promise<CompletionResult> {
    const { system, messages: anthroMessages } = buildAnthropicMessages(messages);

    const { getTools } = await import("../tools/index.ts");
    const tools = (toolsOverride ?? getTools(config)).map((t: any) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));

    const body: any = {
        model: getModelId(config),
        system,
        messages: anthroMessages,
        max_tokens: config.provider?.custom?.max_tokens ?? 1024,
    };
    if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = { type: "auto" };
    }

    const response = await fetch(`${getApiBaseUrl(config)}/v1/messages`, {
        method: "POST",
        headers: {
            "x-api-key": getApiKey(config),
            "anthropic-version": config.provider?.custom?.anthropic_version || "2023-06-01",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic error ${response.status}: ${err}`);
    }

    const data: any = await response.json();
    onFirstToken();

    const toolCalls: ToolCall[] = [];
    let textBuffer = "";
    for (const block of data.content || []) {
        if (block.type === "text") {
            textBuffer += block.text || "";
        } else if (block.type === "tool_use") {
            toolCalls.push({
                id: block.id,
                type: "function",
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input ?? {}),
                },
            });
        }
    }

    const usage = data.usage
        ? {
              prompt_tokens: data.usage.input_tokens || 0,
              completion_tokens: data.usage.output_tokens || 0,
          }
        : null;

    return { text: textBuffer || null, toolCalls, usage, reasoning: "" };
}
