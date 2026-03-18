import { handleToolCall } from "./tools.ts";
import { getApiBaseUrl, getApiKey, getModelId, getTools, type OpoclawConfig } from "./config.ts";

interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

interface UsageStats {
    total: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
    sessions: Array<{
        timestamp: string;
        model: string;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
    }>;
}

const USAGE_FILE = new URL("../usage.json", import.meta.url).pathname;

async function loadUsage(): Promise<UsageStats> {
    try {
        const file = Bun.file(USAGE_FILE);
        if (await file.exists()) {
            return await file.json();
        }
    } catch { }
    return { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, sessions: [] };
}

async function saveUsage(stats: UsageStats): Promise<void> {
    await Bun.write(USAGE_FILE, JSON.stringify(stats, null, 2));
}

async function recordUsage(usage: any, model: string): Promise<void> {
    if (!usage) return;
    const stats = await loadUsage();
    const entry = {
        timestamp: new Date().toISOString(),
        model,
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: usage.prompt_tokens_details?.cache_write_tokens || 0,
        cost: usage.cost || 0,
    };
    stats.sessions.push(entry);
    stats.total.input += entry.input;
    stats.total.output += entry.output;
    stats.total.cacheRead += entry.cacheRead;
    stats.total.cacheWrite += entry.cacheWrite;
    stats.total.cost += entry.cost;
    // Keep last 500 entries
    if (stats.sessions.length > 500) {
        stats.sessions = stats.sessions.slice(-500);
    }
    await saveUsage(stats);
}

async function streamCompletion(
    messages: Message[],
    config: OpoclawConfig,
    onFirstToken: () => void
): Promise<{ text: string | null; toolCalls: ToolCall[]; usage: any; reasoning: string }> {
    const body: any = {
        model: getModelId(config),
        messages,
        tools: getTools(config),
        tool_choice: "auto",
        stream: true,
    };

    // Add reasoning toggle
    if (config.enable_reasoning) {
        body.reasoning = { enabled: true };
    }

    const response = await fetch(`${getApiBaseUrl(config)}/v1/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${getApiKey(config)}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${err}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    let textBuffer = "";
    let firstToken = false;
    const toolCallMap: Record<number, { id: string; name: string; arguments: string }> = {};
    let finishReason: string | null = null;
    let usage: any = null;
    let reasoningBuffer = "";
    let sseBuffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") { finishReason = finishReason ?? "stop"; continue; }

            let parsed: any;
            try {
                parsed = JSON.parse(data);
            } catch (e) {
                continue;
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            finishReason = choice.finish_reason ?? finishReason;

            // Capture usage from the chunk (OpenRouter sends it per-stream)
            if (parsed.usage) {
                usage = parsed.usage;
            }

            const delta = choice.delta;
            if (!delta) continue;

            const reasoningDelta = (delta as any).reasoning;
            if (reasoningDelta) {
                if (typeof reasoningDelta === "string") {
                    reasoningBuffer += reasoningDelta;
                } else if (reasoningDelta.content) {
                    reasoningBuffer += reasoningDelta.content;
                }
                if (!firstToken) {
                    firstToken = true;
                    onFirstToken();
                }
            }

            if (delta.content) {
                if (!firstToken) {
                    firstToken = true;
                    onFirstToken();
                }
                textBuffer += delta.content;
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx: number = tc.index ?? 0;
                    if (!toolCallMap[idx]) {
                        toolCallMap[idx] = { id: tc.id ?? "", name: "", arguments: "" };
                    }
                    if (tc.id) toolCallMap[idx].id = tc.id;
                    if (tc.function?.name) toolCallMap[idx].name += tc.function.name;
                    if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments;
                }

                if (!firstToken) {
                    firstToken = true;
                    onFirstToken();
                }
            }
        }
    }

    const toolCalls: ToolCall[] = Object.entries(toolCallMap).map(([, tc]) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
    }));

    return { text: textBuffer || null, toolCalls, usage, reasoning: reasoningBuffer };
}

async function generateReasoningSummary(
    reasoningText: string,
    config: OpoclawConfig
): Promise<string> {
    const model = config.reasoning_summary_model || getModelId(config);
    const response = await fetch(`${getApiBaseUrl(config)}/v1/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${getApiKey(config)}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: "user",
                    content: `Summarize this reasoning in one short sentence (no markdown, just plain text):\n\n${reasoningText.slice(0, 3000)}`
                },
            ],
            stream: false,
            max_tokens: 500,
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.log(`[summary] API error ${response.status}: ${errText.slice(0, 200)}`);
        return "(reasoning summary failed)";
    }

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "(no summary)";
}

export async function runAgent(
    history: Message[],
    systemPrompt: string,
    config: OpoclawConfig,
    onFirstToken: () => void,
    onToolCall: (call: ToolCall, uniqueId: string) => void,
    onToolCallError: (uniqueId: string, error: Error) => void
): Promise<{ text: string; reasoningSummary?: string; ranTools?: boolean }> {
    const messages: Message[] = [
        { role: "system", content: systemPrompt },
        ...history,
    ];

    let firstTokenFired = false;
    const wrappedOnFirstToken = () => {
        if (!firstTokenFired) {
            firstTokenFired = true;
            onFirstToken();
        }
    };

    for (let iteration = 0; iteration < 20; iteration++) {
        const result = await streamCompletion(
            messages,
            config,
            wrappedOnFirstToken
        );
        const { text, toolCalls, usage } = result;

        // Record usage
        if (usage) {
            await recordUsage(usage, getModelId(config));
        }

        if (toolCalls.length > 0) {
            messages.push({
                role: "assistant",
                content: text,
                tool_calls: toolCalls,
            });

            for (const tc of toolCalls) {
                let result: string;
                let uniqueId = Math.random().toString(36).substring(2, 10);
                try {
                    const args = JSON.parse(tc.function.arguments);
                    if (onToolCall) {
                        onToolCall(tc, uniqueId);
                    }
                    result = await handleToolCall(tc.function.name, args, config).catch((e) => {
                        if (onToolCallError) {
                            onToolCallError(uniqueId, e);
                        }
                        return `Error: ${e.toString()}`;
                    });
                } catch (e: any) {
                    if (onToolCallError) {
                        onToolCallError(uniqueId, e);
                    }
                    result = `Error: ${e.toString()}`;
                }
                messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    name: tc.function.name,
                    content: result,
                });
            }

            continue;
        }

        // No tool calls — final text response
        const responseText = text ?? "(no response)";

        // Generate reasoning summary if enabled and we have reasoning text
        let reasoningSummaryText: string | undefined;
        if (config.reasoning_summary && config.enable_reasoning && result.reasoning) {
            reasoningSummaryText = await generateReasoningSummary(
                result.reasoning,
                config
            );
        }

        return { text: responseText, reasoningSummary: reasoningSummaryText, ranTools: toolCalls.length > 0 };
    }

    return { text: "(agent loop limit reached)" };
}

export type { Message, OpoclawConfig };
