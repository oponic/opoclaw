import { TOOL_DEFINITIONS, handleToolCall } from "./tools.ts";

interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

interface Config {
    openrouterKey: string;
    openrouterModel: string;
    enableReasoning?: boolean;
    reasoningSummary?: boolean;
    reasoningSummaryModel?: string;
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
    } catch {}
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
    config: Config,
    onFirstToken: () => void
): Promise<{ text: string | null; toolCalls: ToolCall[]; usage: any }> {
    const body: any = {
        model: config.openrouterModel,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        stream: true,
    };

    // Add reasoning toggle
    if (config.enableReasoning) {
        body.reasoning = { enabled: true };
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.openrouterKey}`,
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

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") { finishReason = finishReason ?? "stop"; continue; }

            let parsed: any;
            try { parsed = JSON.parse(data); } catch { continue; }

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
    config: Config
): Promise<string> {
    const model = config.reasoningSummaryModel || config.openrouterModel;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.openrouterKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            messages: [
                {
                    role: "user",
                    content: `Summarize this reasoning in one short sentence (no markdown, just plain text):\n\n${reasoningText.slice(0, 3000)}`,
                },
            ],
            stream: false,
            max_tokens: 100,
        }),
    });

    if (!response.ok) return "(reasoning summary failed)";

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "(no summary)";
}

export async function runAgent(
    history: Message[],
    systemPrompt: string,
    config: Config,
    onFirstToken: () => void
): Promise<{ text: string; reasoningSummary?: string }> {
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
            await recordUsage(usage, config.openrouterModel);
        }

        if (toolCalls.length > 0) {
            messages.push({
                role: "assistant",
                content: text,
                tool_calls: toolCalls,
            });

            for (const tc of toolCalls) {
                let result: string;
                try {
                    const args = JSON.parse(tc.function.arguments);
                    result = await handleToolCall(tc.function.name, args);
                } catch (e: any) {
                    result = `Error: ${e.message}`;
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
        if (config.reasoningSummary && config.enableReasoning && result.reasoning) {
            reasoningSummaryText = await generateReasoningSummary(
                result.reasoning,
                config
            );
        }

        return { text: responseText, reasoningSummary: reasoningSummaryText };
    }

    return { text: "(agent loop limit reached)" };
}

export type { Message, Config };
