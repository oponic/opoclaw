import { getTools, handleToolCall, type ToolContext } from "./tools/index.ts";
import type { ToolSchema } from "./tools/types.ts";
import { getApiBaseUrl, getApiKey, getModelId, getActiveProvider, type OpoclawConfig } from "./config.ts";
import { recordUsage } from "./usage.ts";

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
    if (text === "(agent loop limit reached)") return [];
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

    const session = new AgentSession(sessionId);
    session.addMessage({ role: "user", content: query });

    let searchBatch: ToolResult[] = [];

    const result = await session.evaluate(systemPrompt, config, {
        onFirstToken: () => {},
        onToolCall: () => {},
        onToolCallError: () => {},
        onToolBatch: async (_calls, results) => {
            if (!onSearchSummary) return;
            const searchResults = results.filter(r => r.name === "search");
            if (searchResults.length === 0) return;
            searchBatch.push(...searchResults);
            if (searchBatch.length >= 3) {
                try {
                    const summary = await summarizeToolBatch([], searchBatch, config, sessionId);
                    if (summary.trim()) await onSearchSummary(summary.trim());
                } catch {}
                searchBatch = [];
            }
        },
    }, {
        maxIterations: 200,
        tools: getTools(config).filter(t => ["search", "web_fetch", "get_time"].includes(t.function.name)),
    });

    const docs = parseDeepResearchDocs(result.text || "");
    if (docs.length === 0) {
        if (result.text === "(agent loop limit reached)") return "Deep research terminated (iteration limit reached).";
        return "Deep research completed, but no documents were produced.";
    }
    const compiled = docs.map(d => `# ${d.title}\n\n${d.content}`.trim()).join("\n\n");
    return `Deep Research Docs:\n\n${compiled}`;
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

export type BackgroundSubagentJob = {
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
    currentSystemPrompt: string = "";
    pendingFileSend: { path: string; caption: string } | null = null;
    private backgroundJobs = new Map<string, BackgroundSubagentJob>();

    constructor(sessionId?: string) {
        this.sessionId = sessionId;
        this.messages = [];
    }


    registerBackgroundJob(job: BackgroundSubagentJob): void {
        if(this.backgroundJobs.get(job.id)?.status == "running") {
            throw new Error("Job id already in use");
        }
        this.backgroundJobs.set(job.id, job);
    }

    async compact(preserveRecent: number, config: OpoclawConfig): Promise<string> {
        const current = this.messages.slice(0, Math.max(0, this.messages.length - 1));
        const transcript = this.serializeMessagesForPrompt(current);
        const summary = await this.runSubagentRequest(
            "Compress this conversation context into 2-4 concise paragraphs preserving key facts, decisions, constraints, and unresolved tasks.\n\n" + transcript,
            false,
            this.currentSystemPrompt,
            config,
        );

        const tail = this.messages.slice(-preserveRecent);
        this.messages = [
            {
                role: "user",
                content:
                    "Conversation context summary (generated by compact tool):\n\n" +
                    summary,
            },
            ...tail,
        ];
        return `Context compacted. Summary length: ${summary.length} chars.`;
    }

    async deepResearch(query: string, config: OpoclawConfig, onSearchSummary?: (summary: string) => Promise<void>): Promise<string> {
        const sessionId = this.sessionId ? `${this.sessionId}-deepresearch-${Date.now()}` : undefined;
        return runDeepResearch(query, config, onSearchSummary, sessionId);
    }

    addMessage(msg: Message): void {
        this.messages.push(msg);
        this.trimContextByChars();
    }

    serializeMessagesForPrompt(messages: Message[]): string {
        return messages
            .map((m) => {
                const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
                return `[${m.role}] ${content}`;
            })
            .join("\n\n")
            .slice(0, 120000);
    }

    async runSubagentRequest(
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

    private trimContextByChars(): void {
        const MAX_USER_MESSAGES = 50;
        const USER_MESSAGES_TO_KEEP = 40;
        const MAX_TOTAL_MESSAGES = 100;
        const MAX_CHAR_COUNT = 100_000;

        const msgLen = (m: Message): number => {
            const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
            return c.length;
        };

        const userCount = this.messages.filter(m => m.role === "user").length;
        if (userCount > MAX_USER_MESSAGES) {
            const toDrop = userCount - USER_MESSAGES_TO_KEEP - 1;
            let dropped = 0;
            let cutIndex = 0;
            for (let i = 0; i < this.messages.length; i++) {
                if (this.messages[i]!.role === "user") {
                    dropped++;
                    if (dropped === toDrop) { cutIndex = i + 1; break; }
                }
            }
            this.messages.splice(0, cutIndex);
        }

        let distFromEnd = -1;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i]!.role === "user") { distFromEnd = this.messages.length - 1 - i; break; }
        }
        const minSafeLength = distFromEnd + 1;

        if (this.messages.length > MAX_TOTAL_MESSAGES) {
            const toRemove = this.messages.length - Math.max(MAX_TOTAL_MESSAGES, minSafeLength);
            if (toRemove > 0) this.messages.splice(0, toRemove);
        }

        let total = this.messages.reduce((s, m) => s + msgLen(m), 0);
        while (total > MAX_CHAR_COUNT && this.messages.length > minSafeLength) {
            total -= msgLen(this.messages[0]!);
            this.messages.splice(0, 1);
        }

        while (this.messages.length > 0 && this.messages[0]!.role !== "user") {
            this.messages.splice(0, 1);
        }
    }

    async evaluate(
        systemPrompt: string,
        config: OpoclawConfig,
        callbacks: AgentCallbacks,
        options?: { maxIterations?: number; tools?: ToolSchema[] }
    ): Promise<{ text: string; reasoningSummary?: string; ranTools?: boolean }> {
        this.currentSystemPrompt = systemPrompt;
        const systemMessage: Message = { role: "system", content: systemPrompt };

        let firstTokenFired = false;
        const wrappedOnFirstToken = () => {
            if (!firstTokenFired) {
                firstTokenFired = true;
                callbacks.onFirstToken();
            }
        };

        let didRunTools = false;
        const maxIterations = options?.maxIterations ?? 20;

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            this.trimContextByChars();
            this.injectBackgroundResultsIntoContext();

            const result = await streamCompletion(
                [systemMessage, ...this.messages],
                config,
                wrappedOnFirstToken,
                options?.tools,
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
                            return await handleToolCall(tc.function.name, args, {
                                config,
                                session: this,
                                onDeepResearchSummary: callbacks.onDeepResearchSummary,
                                setPendingFileSend: v => { this.pendingFileSend = v; },
                            });
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
                        toolResult = `Error: ${e instanceof Error ? e.message : String(e)}`;
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
