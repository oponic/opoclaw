import OpenAI from "openai";
import { getApiBaseUrl, getApiKey, getActiveProvider, getModelId, type OpoclawConfig } from "../config.ts";
import { type ToolSchema } from "../tools/index.ts";
import type { Message, ToolCall, CompletionResult } from "./types.ts";

export function buildClientOptions(config: OpoclawConfig) {
    const options: Record<string, any> = {
        apiKey: getApiKey(config) || "ollama",
        baseURL: `${getApiBaseUrl(config)}/v1`,
    };
    if (getActiveProvider(config) === "openrouter") {
        options.defaultHeaders = {
            "HTTP-Referer": "https://github.com/oponic/opoclaw",
            "X-Title": "opoclaw",
        };
    }
    return options;
}

export async function generateCompletion(
    messages: Message[],
    config: OpoclawConfig,
    onFirstToken: () => void,
    tools: ToolSchema[],
    sessionId: string,
): Promise<CompletionResult> {
    const client = new OpenAI(buildClientOptions(config));

    const requestParams: any = {
        model: getModelId(config),
        messages: messages as any,
    };
    if (tools.length > 0) {
        requestParams.tools = tools;
        requestParams.tool_choice = "auto";
    }

    if (getActiveProvider(config) === "openrouter") {
        if (config.enable_reasoning) {
            requestParams.reasoning = { enabled: true };
        }
        if (config.provider?.openrouter?.use_session_ids !== false) {
            requestParams.session_id = sessionId;
        }
    }

    const data = await client.chat.completions.create(requestParams);
    onFirstToken();

    const message = data.choices?.[0]?.message;
    const rawReasoning = (message as any)?.reasoning;
    const reasoning = typeof rawReasoning === "string"
        ? rawReasoning
        : (rawReasoning?.content ?? "");

    const toolCalls: ToolCall[] = (message?.tool_calls || []).map((tc: any) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
        text: message?.content || null,
        toolCalls,
        usage: data.usage ?? null,
        reasoning,
        reasoning_details: (message as any).reasoning_details ?? null
    };
}
