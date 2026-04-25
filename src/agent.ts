import { getTools, handleToolCall, type ToolContext } from "./tools/index.ts";
import { getApiBaseUrl, getApiKey, getModelId, getActiveProvider, type OpoclawConfig } from "./config.ts";
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
                    output = await handleToolCall(tc.function.name, args, { config });
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

type BackgroundSubagentJob = {
    id: string;
    label: string;
    request: string;
    status: "running" | "done" | "error";
    output?: string;
    injected?: boolean;
};

export class AgentSession {
    sessionId: string | undefined;
    messages: Message[];
    pendingFileSend: { path: string; caption: string } | null = null;
    private backgroundJobs = new Map<string, BackgroundSubagentJob>();
    private pendingCompaction: { summary: string; preserveRecent: number } | null = null;

    constructor(sessionId?: string) {
        this.sessionId = sessionId;
        this.messages = [];
    }

    addMessage(msg: Message): void {
        this.messages.push(msg);
        const userCount = this.messages.filter(m => m.role === "user").length;
        if (userCount > 50) {
            const toDrop = userCount - 40;
            let dropped = 0;
            let cutIndex = 0;
            for (let i = 0; i < this.messages.length; i++) {
                if (this.messages[i]!.role === "user") {
                    dropped++;
                    if (dropped === toDrop) {
                        cutIndex = i + 1;
                        break;
                    }
                }
            }
            this.messages.splice(0, cutIndex);
        }
    }

    private serializeMessagesForPrompt(messages: Message[]): string {
        return messages
            .map((m) => {
                const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
                return `[${m.role}] ${content}`;
            })
            .join("\n\n")
            .slice(0, 120000);
    }

    private async runSubagentRequest(
        request: string,
        includeContext: boolean,
        parentSystemPrompt: string,
        config: OpoclawConfig,
    ): Promise<string> {
        const contextMessages = includeContext ? this.messages.slice(-24) : [];
        const contextBlock = includeContext && contextMessages.length > 0
            ? `\n\nParent context:\n${this.serializeMessagesForPrompt(contextMessages)}`
            : "";

        const subagentMessages: Message[] = [
            {
                role: "system",
                content:
                    `${parentSystemPrompt}\n\n` +
                    "You are operating as a subagent. Complete the delegated request and return only the final result.",
            },
            {
                role: "user",
                content: `Delegated request:\n${request}${contextBlock}`,
            },
        ];

        const subSessionId = this.sessionId
            ? `${this.sessionId}-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            : undefined;
        const result = await streamCompletion(subagentMessages, config, () => {}, [], subSessionId);
        if (result.usage) {
            await recordUsage(result.usage, getModelId(config));
        }
        if (result.toolCalls.length > 0) {
            return "Subagent returned tool calls, but tool execution is disabled for subagents.";
        }
        return (result.text || "").trim() || "(subagent returned no output)";
    }

    private applyPendingCompaction(): void {
        if (!this.pendingCompaction) return;
        const preserveRecent = Math.max(2, Math.min(20, this.pendingCompaction.preserveRecent || 6));
        const tail = this.messages.slice(-preserveRecent);
        this.messages = [
            {
                role: "assistant",
                content:
                    "Conversation context summary (generated by compact tool):\n\n" +
                    this.pendingCompaction.summary,
            },
            ...tail,
        ];
        this.pendingCompaction = null;
    }

    private injectBackgroundResultsIntoContext(): boolean {
        let injected = false;
        for (const job of this.backgroundJobs.values()) {
            if (job.status === "running" || job.injected) continue;
            const outcome = job.status === "done"
                ? (job.output || "(no output)")
                : `Error: ${job.output || "background subagent failed."}`;
            this.addMessage({
                role: "user",
                content:
                    `Background subagent completed (${job.label}).\n` +
                    `Original request:\n${job.request}\n\n` +
                    `Result:\n${outcome}\n\n` +
                    "Please continue using this result.",
            });
            job.injected = true;
            injected = true;
        }
        return injected;
    }

    private async yieldForBackgroundJobs(): Promise<void> {
        if (!Array.from(this.backgroundJobs.values()).some((job) => job.status === "running" && !job.injected)) {
            return;
        }
        // Yield several times to allow microtasks and some macrotasks (I/O) to finish
        // for background jobs that are expected to be nearly immediate.
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (!Array.from(this.backgroundJobs.values()).some((job) => job.status === "running" && !job.injected)) {
                break;
            }
        }
    }

    async evaluate(
        systemPrompt: string,
        config: OpoclawConfig,
        callbacks: AgentCallbacks
    ): Promise<{ text: string; reasoningSummary?: string; ranTools?: boolean }> {
        const systemMessage: Message = { role: "system", content: systemPrompt };

        let firstTokenFired = false;
        const wrappedOnFirstToken = () => {
            if (!firstTokenFired) {
                firstTokenFired = true;
                callbacks.onFirstToken();
            }
        };

        let didRunTools = false;

        for (let iteration = 0; iteration < 20; iteration++) {
            this.injectBackgroundResultsIntoContext();

            const result = await streamCompletion(
                [systemMessage, ...this.messages],
                config,
                wrappedOnFirstToken,
                undefined,
                this.sessionId
            );
            const { text, toolCalls, usage } = result;

            if (usage) {
                await recordUsage(usage, getModelId(config));
            }

            if (toolCalls.length > 0) {
                didRunTools = true;
                this.messages.push({
                    role: "assistant",
                    content: text,
                    tool_calls: toolCalls,
                });

                const toolResults: ToolResult[] = [];
                for (const tc of toolCalls) {
                    let toolResult: string;
                    const uniqueId = Math.random().toString(36).substring(2, 10);
                    try {
                        const args = JSON.parse(tc.function.arguments);
                        if (callbacks.onToolCall) {
                            callbacks.onToolCall(tc, uniqueId);
                        }
                        const runTool = async () => {
                            if (callbacks.executeTool) {
                                const handled = await callbacks.executeTool(tc, args);
                                if (handled !== undefined) return handled;
                            }
                            if (tc.function.name === "compact") {
                                const preserveRecentRaw = Number(args.preserve_recent_messages ?? 6);
                                const preserveRecent = Number.isFinite(preserveRecentRaw)
                                    ? Math.max(2, Math.min(20, Math.round(preserveRecentRaw)))
                                    : 6;
                                const current = this.messages.slice(0, Math.max(0, this.messages.length - 1));
                                const transcript = this.serializeMessagesForPrompt(current);
                                const summary = await this.runSubagentRequest(
                                    "Compress this conversation context into 2-4 concise paragraphs preserving key facts, decisions, constraints, and unresolved tasks.\n\n" + transcript,
                                    false,
                                    systemPrompt,
                                    config,
                                );
                                this.pendingCompaction = { summary, preserveRecent };
                                return `Context compaction prepared. Summary length: ${summary.length} chars.`;
                            }
                            if (tc.function.name === "run_subagent") {
                                const request = String(args.request || "").trim();
                                if (!request) throw new Error("Missing 'request' argument for run_subagent.");
                                const includeContext = args.include_context !== false;
                                const output = await this.runSubagentRequest(request, includeContext, systemPrompt, config);
                                return output;
                            }
                            if (tc.function.name === "run_background_subagent") {
                                const request = String(args.request || "").trim();
                                if (!request) throw new Error("Missing 'request' argument for run_background_subagent.");
                                const includeContext = args.include_context !== false;
                                const label = String(args.label || `bg-${Date.now()}`);
                                const id = `subbg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                                const job: BackgroundSubagentJob = {
                                    id,
                                    label,
                                    request,
                                    status: "running",
                                };
                                this.backgroundJobs.set(id, job);
                                void (async () => {
                                    try {
                                        const output = await this.runSubagentRequest(
                                            request,
                                            includeContext,
                                            systemPrompt,
                                            config,
                                        );
                                        job.status = "done";
                                        job.output = output;
                                    } catch (e: any) {
                                        job.status = "error";
                                        job.output = String(e?.message || e || "unknown error");
                                    }
                                })();
                                return `Background subagent started (${id}). Label: ${label}.`;
                            }
                            if (tc.function.name === "timer") {
                                const seconds = Number(args.seconds);
                                if (isNaN(seconds) || seconds <= 0) throw new Error("Invalid 'seconds' argument for timer. Must be a positive number.");
                                const label = String(args.label || `timer-${Date.now()}`);
                                const id = `timer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                                const job: BackgroundSubagentJob = {
                                    id,
                                    label,
                                    request: `Timer for ${seconds} seconds`,
                                    status: "running",
                                };
                                this.backgroundJobs.set(id, job);
                                setTimeout(() => {
                                    job.status = "done";
                                    job.output = `Timer expired at ${new Date().toLocaleTimeString()}.`;
                                }, seconds * 1000);
                                return `Timer set for ${seconds} seconds (${id}). Label: ${label}.`;
                            }
                            if (tc.function.name === "session_status") {
                                const modelId = getModelId(config);
                                const provider = getActiveProvider(config);
                                let channel = "unknown";
                                if (this.sessionId?.startsWith("opoclaw-openai-")) channel = "openai";
                                else if (this.sessionId?.startsWith("opoclaw-core-")) channel = "core/terminal";
                                else if (this.sessionId?.includes("discord")) channel = "discord";
                                else if (this.sessionId?.includes("irc")) channel = "irc";

                                const usageStats = await loadUsage();
                                const now = new Date();
                                const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                                const recentSpending = usageStats.sessions
                                    .filter(s => new Date(s.timestamp) >= oneDayAgo)
                                    .reduce((acc, s) => acc + (s.cost || 0), 0);

                                const messageCount = this.messages.length;
                                let charCount = 0;
                                for (const m of this.messages) {
                                    if (typeof m.content === "string") charCount += m.content.length;
                                    else if (Array.isArray(m.content)) {
                                        for (const part of m.content) {
                                            if (part.type === "text") charCount += (part.text || "").length;
                                        }
                                    }
                                }
                                const estimatedTokens = Math.ceil(charCount / 4);

                                return [
                                    "Session Status:",
                                    `- Model: ${modelId} (${provider})`,
                                    `- Channel: ${channel}`,
                                    `- Context Usage: ~${estimatedTokens} tokens (${charCount} chars) in ${messageCount} messages.`,
                                    `- Context Window: Model-dependent (check provider documentation for ${modelId}).`,
                                    `- Spending (last 24h): $${recentSpending.toFixed(4)}`
                                ].join("\n");
                            }
                            if (tc.function.name === "deep_research") {
                                const deepResearchSessionId = this.sessionId ? `${this.sessionId}-deepresearch-${Date.now()}` : undefined;
                                return await runDeepResearch(String(args.query || ""), config, callbacks.onDeepResearchSummary, deepResearchSessionId);
                            }
                            return await handleToolCall(tc.function.name, args, { config, setPendingFileSend: v => { this.pendingFileSend = v; } });
                        };
                        if (callbacks.requestToolApproval) {
                            const approval = await callbacks.requestToolApproval(tc, uniqueId);
                            if (!approval.approved) {
                                toolResult = approval.message || "Not authorized to perform this action.";
                            } else {
                                toolResult = await runTool();
                            }
                        } else {
                            toolResult = await runTool();
                        }
                    } catch (e: any) {
                        if (callbacks.onToolCallError) {
                            callbacks.onToolCallError(uniqueId, e);
                        }
                        toolResult = `Error: ${e.toString()}`;
                    }
                    toolResults.push({
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                        output: toolResult,
                    });
                    this.messages.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        name: tc.function.name,
                        content: toolResult,
                    });
                    this.applyPendingCompaction();
                }

                if (callbacks.onToolBatch) {
                    await callbacks.onToolBatch(toolCalls, toolResults, this.sessionId);
                }

                // Let background subagent jobs settle so completed results can be
                // injected before the next model turn without hard-blocking.
                await this.yieldForBackgroundJobs();
                this.injectBackgroundResultsIntoContext();

                continue;
            }

            const responseText = text ?? "";

            let reasoningSummaryText: string | undefined;
            if (config.reasoning_summary && config.enable_reasoning && result.reasoning) {
                reasoningSummaryText = await generateReasoningSummary(
                    result.reasoning,
                    config,
                    this.sessionId
                );
            }

            this.messages.push({ role: "assistant", content: responseText });

            // Final check for background results that might have finished during the last turn
            this.injectBackgroundResultsIntoContext();

            return { text: responseText, reasoningSummary: reasoningSummaryText, ranTools: didRunTools };
        }

        const fallback = "(agent loop limit reached)";
        this.messages.push({ role: "assistant", content: fallback });
        return { text: fallback };
    }
}

export async function runAgent(
    history: Message[],
    systemPrompt: string,
    config: OpoclawConfig,
    callbacks: AgentCallbacks,
    sessionId?: string
): Promise<{ text: string; reasoningSummary?: string; ranTools?: boolean }> {
    const session = new AgentSession(sessionId);
    session.messages = [...history];
    return session.evaluate(systemPrompt, config, callbacks);
}

export type { Message, OpoclawConfig };
