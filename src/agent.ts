import { handleToolCall } from "./tools.ts";
import { getApiBaseUrl, getApiKey, getModelId, getTools, getActiveProvider, type OpoclawConfig } from "./config.ts";
import { dirname, join } from "path";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";

interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: any | null;
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

interface ToolResult {
    name: string;
    arguments: string;
    output: string;
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

function normalizeWindowsPath(p: string): string {
    if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(p)) {
        return p.slice(1);
    }
    return p;
}

function getUsageFilePath(): string {
  const rawPath = normalizeWindowsPath(fileURLToPath(new URL("../usage.json", import.meta.url)));
  const dir = dirname(rawPath);
  // If the directory is root, use a subdirectory instead
  if (dir === "/" || /^[A-Za-z]:\\$/.test(dir) || dir === ".") {
    // Fallback to a data directory inside the project
    const fallback = join(dirname(rawPath), "data", "usage.json");
    return fallback;
  }
  return rawPath;
}

const USAGE_FILE = getUsageFilePath();

function isAnthropicCustom(config: OpoclawConfig): boolean {
    return config.provider?.active === "custom" && config.provider?.custom?.api_type === "anthropic";
}

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
    try {
        await mkdir(dirname(USAGE_FILE), { recursive: true });
    } catch (err) {
        // If we can't create directory (e.g., permission denied), log warning and continue
        console.warn(`Could not create directory for usage file: ${err}`);
    }
    try {
        await Bun.write(USAGE_FILE, JSON.stringify(stats, null, 2));
    } catch (err) {
        // If writing fails, log warning but don't throw (usage tracking is non-critical)
        console.warn(`Could not write usage file: ${err}`);
    }
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
    onFirstToken: () => void,
    toolsOverride?: any[],
    sessionId?: string
): Promise<{ text: string | null; toolCalls: ToolCall[]; usage: any; reasoning: string }> {
    if (isAnthropicCustom(config)) {
        const { system, messages: anthroMessages } = buildAnthropicMessages(messages);
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

    const body: any = {
        model: getModelId(config),
        messages,
        tools: toolsOverride ?? getTools(config),
        tool_choice: "auto",
        stream: true,
    };

    // Add reasoning toggle (only supported by OpenRouter)
    if (config.enable_reasoning && getActiveProvider(config) === "openrouter") {
        body.reasoning = { enabled: true };
    }

    const response = await fetch(`${getApiBaseUrl(config)}/v1/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${getApiKey(config)}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            ...body,
            ...(sessionId != undefined ? { session_id: sessionId } : {})
        }),
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
    config: OpoclawConfig,
    sessionId?: string
): Promise<string> {
    if (isAnthropicCustom(config)) {
        return "(no summary)";
    }
    const model = config.reasoning_summary_model || getModelId(config);
    const response = await fetch(`${getApiBaseUrl(config)}/v1/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${getApiKey(config)}`,
            "Content-Type": "application/json"
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
            ...(sessionId != undefined ? {session_id: sessionId}:{})
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

export async function summarizeToolBatch(
    calls: ToolCall[],
    results: ToolResult[],
    config: OpoclawConfig,
    sessionId?: string
): Promise<string> {
    const summaryInput = results.map((r) => ({
        name: r.name,
        arguments: r.arguments,
        output: r.output.slice(0, 1000),
    }));
    const prompt = `Write one short, high-level sentence summarizing what was accomplished. It should mention the objective or outcome, not the tools or files used. No markdown, no bullet points.\n\n${JSON.stringify(summaryInput, null, 2)}`;

    if (isAnthropicCustom(config)) {
        const response = await fetch(`${getApiBaseUrl(config)}/v1/messages`, {
            method: "POST",
            headers: {
                "x-api-key": getApiKey(config),
                "anthropic-version": config.provider?.custom?.anthropic_version || "2023-06-01",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: getModelId(config),
                system: "You summarize actions at a high level without mentioning tools or files. Output exactly one short sentence.",
                messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
                max_tokens: 200,
            }),
        });
        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`Summary API error ${response.status}: ${errText.slice(0, 200)}`);
        }
        const data: any = await response.json();
        const text = data?.content?.map((b: any) => b?.text).filter(Boolean).join("") || "";
        return text.trim();
    }

    const response = await fetch(`${getApiBaseUrl(config)}/v1/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${getApiKey(config)}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: getModelId(config),
            messages: [
                { role: "system", content: "You summarize actions at a high level without mentioning tools or files. Output exactly one short sentence." },
                { role: "user", content: prompt },
            ],
            stream: false,
            max_tokens: 200,
            ...(sessionId != undefined ? { session_id: sessionId } : {})
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Summary API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
}

function parseDeepResearchDocs(text: string): { title: string; content: string }[] {
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.docs)) {
            return parsed.docs
                .filter((d: any) => d?.title && d?.content)
                .map((d: any) => ({ title: String(d.title), content: String(d.content) }));
        }
        if (Array.isArray(parsed)) {
            return parsed
                .filter((d: any) => d?.title && d?.content)
                .map((d: any) => ({ title: String(d.title), content: String(d.content) }));
        }
    } catch {
    }
    const fallback = text.trim();
    if (!fallback) return [];
    return [{ title: "Research Summary", content: fallback }];
}

export async function runDeepResearch(
    query: string,
    config: OpoclawConfig,
    onSearchSummary?: (summary: string) => Promise<void>,
    sessionId?: string
): Promise<string> {
    const systemPrompt =
        "You are in Deep Research mode. Use search and web_fetch to gather information. " +
        "Synthesize 2-4 concise markdown documents. Output JSON: {\"docs\":[{\"title\":\"...\",\"content\":\"...\"}]} " +
        "Only output JSON, no markdown fences.";

    const messages: Message[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
    ];

    const searchBatch: ToolResult[] = [];
    let searchCount = 0;
    const MAX_MESSAGE_CHARS = 120000;
    const MAX_TURNS = 40;
    const MAX_TOOL_OUTPUT = 4000;

    const totalChars = () =>
        messages.reduce((sum, m) => {
            const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
            return sum + (c?.length || 0);
        }, 0);

    const trimMessages = () => {
        while (messages.length > MAX_TURNS) {
            messages.splice(1, 1);
        }
        while (totalChars() > MAX_MESSAGE_CHARS && messages.length > 2) {
            messages.splice(1, 1);
        }
    };

    for (let iteration = 0; iteration < 200; iteration++) {
        trimMessages();
        const result = await streamCompletion(messages, config, () => {}, undefined, sessionId);
        const { text, toolCalls } = result;

        if (toolCalls.length > 0) {
            messages.push({ role: "assistant", content: text, tool_calls: toolCalls });
            for (const tc of toolCalls) {
                let output = "";
                try {
                    const args = JSON.parse(tc.function.arguments);
                    output = await handleToolCall(tc.function.name, args, config);
                } catch (e: any) {
                    output = `Error: ${e?.message || e}`;
                }
                if (output.length > MAX_TOOL_OUTPUT) {
                    output = output.slice(0, MAX_TOOL_OUTPUT) + "…";
                }

                const toolResult: ToolResult = {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                    output,
                };

                if (tc.function.name === "search") {
                    searchBatch.push(toolResult);
                    searchCount += 1;
                    if (searchBatch.length >= 3 && onSearchSummary) {
                        try {
                            const summary = await summarizeToolBatch([], searchBatch, config, sessionId);
                            const trimmed = summary.trim();
                            if (trimmed) {
                                await onSearchSummary(trimmed);
                            }
                        } catch {
                        }
                        searchBatch.length = 0;
                    }
                }

                messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    name: tc.function.name,
                    content: output,
                });
            }
            continue;
        }

        const docs = parseDeepResearchDocs(text || "");
        if (docs.length === 0) return "Deep research completed, but no documents were produced.";

        const compiled = docs
            .map((d) => `# ${d.title}\n\n${d.content}`.trim())
            .join("\n\n");
        return `Deep Research Docs:\n\n${compiled}`;
    }

    return "Deep research terminated (iteration limit reached).";
}

export interface AgentCallbacks {
    onFirstToken: () => void,
    onToolCall: (call: ToolCall, uniqueId: string) => void,
    onToolCallError: (uniqueId: string, error: Error) => void,
    requestToolApproval?: (call: ToolCall, uniqueId: string) => Promise<{ approved: boolean; message?: string }>,
    onToolBatch?: (calls: ToolCall[], results: ToolResult[], sessionId?: string) => Promise<void>,
    onDeepResearchSummary?: (summary: string) => Promise<void>,
    executeTool?: (call: ToolCall, args: Record<string, any>) => Promise<string | undefined>   
}

export async function runAgent(
    history: Message[],
    systemPrompt: string,
    config: OpoclawConfig,
    agent_callbacks: AgentCallbacks,
    sessionId?: string
): Promise<{ text: string; reasoningSummary?: string; ranTools?: boolean }> {
    const messages: Message[] = [
        { role: "system", content: systemPrompt },
        ...history,
    ];

    let firstTokenFired = false;
    const wrappedOnFirstToken = () => {
        if (!firstTokenFired) {
            firstTokenFired = true;
            agent_callbacks.onFirstToken();
        }
    };

    for (let iteration = 0; iteration < 20; iteration++) {
        const result = await streamCompletion(
            messages,
            config,
            wrappedOnFirstToken,
            undefined,
            sessionId
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

            const toolResults: ToolResult[] = [];
            for (const tc of toolCalls) {
                let result: string;
                let uniqueId = Math.random().toString(36).substring(2, 10);
                try {
                    const args = JSON.parse(tc.function.arguments);
                    if (agent_callbacks.onToolCall) {
                        agent_callbacks.onToolCall(tc, uniqueId);
                    }
                    const runTool = async () => {
                        if (agent_callbacks.executeTool) {
                            const handled = await agent_callbacks.executeTool(tc, args);
                            if (handled !== undefined) return handled;
                        }
                        if (tc.function.name === "deep_research") {
                            return await runDeepResearch(String(args.query || ""), config, agent_callbacks.onDeepResearchSummary, sessionId);
                        }
                        return await handleToolCall(tc.function.name, args, config);
                    };
                    if (agent_callbacks.requestToolApproval) {
                        const approval = await agent_callbacks.requestToolApproval(tc, uniqueId);
                        if (!approval.approved) {
                            result = approval.message || "Not authorized to perform this action.";
                        } else {
                            result = await runTool();
                        }
                    } else {
                        result = await runTool();
                    }
                } catch (e: any) {
                    if (agent_callbacks.onToolCallError) {
                        agent_callbacks.onToolCallError(uniqueId, e);
                    }
                    result = `Error: ${e.toString()}`;
                }
                toolResults.push({
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                    output: result,
                });
                messages.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    name: tc.function.name,
                    content: result,
                });
            }

            if (agent_callbacks.onToolBatch) {
                await agent_callbacks.onToolBatch(toolCalls, toolResults, sessionId);
            }

            continue;
        }

        // No tool calls — final text response
        const responseText = text ?? "";

        // Generate reasoning summary if enabled and we have reasoning text
        let reasoningSummaryText: string | undefined;
        if (config.reasoning_summary && config.enable_reasoning && result.reasoning) {
            reasoningSummaryText = await generateReasoningSummary(
                result.reasoning,
                config,
                sessionId
            );
        }

        return { text: responseText, reasoningSummary: reasoningSummaryText, ranTools: toolCalls.length > 0 };
    }

    return { text: "(agent loop limit reached)" };
}

export type { Message, OpoclawConfig };
