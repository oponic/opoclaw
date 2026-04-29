import { getTools, getToolsFiltered, handleToolCallDefinition } from "./tools";
import { defineTool, type ToolDefinition } from "./tools/types.ts";
import { getActiveProvider, getModelId, type OpoclawConfig } from "./config.ts";
import { recordUsage } from "./usage.ts";
import { provider } from "./provider/index.ts";
import type { Message, ToolCall } from "./provider/types.ts";

export type { ToolCall };

interface ToolResult {
    name: string;
    arguments: string;
    output: string;
}

function isAnthropicCustom(config: OpoclawConfig): boolean {
    return config.provider?.active === "custom" && config.provider?.custom?.api_type === "anthropic";
}

function configWithModel(config: OpoclawConfig, model: string): OpoclawConfig {
    const active = getActiveProvider(config);
    if (active === "openrouter") return { ...config, provider: { ...config.provider, openrouter: { ...config.provider?.openrouter, model } } };
    if (active === "ollama") return { ...config, provider: { ...config.provider, ollama: { ...config.provider?.ollama, model } } };
    return { ...config, provider: { ...config.provider, custom: { ...config.provider?.custom, model } } };
}

async function generateReasoningSummary(
    reasoningText: string,
    config: OpoclawConfig,
    sessionId: string
): Promise<string> {
    if (isAnthropicCustom(config)) return "(no summary)";

    const model = config.reasoning_summary_model || getModelId(config);
    const result = await provider.generateCompletion(
        [{ role: "user", content: `Summarize this reasoning in one short sentence (no markdown, just plain text):\n\n${reasoningText.slice(0, 3000)}` }],
        configWithModel(config, model),
        () => {},
        [],
        sessionId,
    );
    return result.text?.trim() || "(no summary)";
}

export async function summarizeToolBatch(
    calls: ToolCall[],
    results: ToolResult[],
    config: OpoclawConfig,
    sessionId: string
): Promise<string> {
    const summaryInput = results.map((r) => ({
        name: r.name,
        arguments: r.arguments,
        output: r.output.slice(0, 1000),
    }));
    const prompt = `Write one short, high-level sentence summarizing what was accomplished. It should mention the objective or outcome, not the tools or files used. No markdown, no bullet points.\n\n${JSON.stringify(summaryInput, null, 2)}`;

    const systemMsg: Message = { role: "system", content: "You summarize actions at a high level without mentioning tools or files. Output exactly one short sentence." };
    const userMsg: Message = { role: "user", content: prompt };

    const result = await provider.generateCompletion([systemMsg, userMsg], config, () => {}, [], sessionId);
    return result.text?.trim() || "";
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
    onSearchSummary: ((summary: string) => Promise<void>) | undefined,
    sessionId: string
): Promise<string> {
    const systemPrompt =
        "You are in Deep Research mode. Use search and web_fetch to gather information. " +
        "Synthesize 2-4 concise markdown documents. Output JSON: {\"docs\":[{\"title\":\"...\",\"content\":\"...\"}]} " +
        "Only output JSON, no markdown fences.";

    const session = new AgentSession(sessionId, true);
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
        tools: getToolsFiltered(config, [], ["search", "web_fetch", "get_time"])
    });

    const docs = parseDeepResearchDocs(result.text || "");
    if (docs.length === 0) {
        if (result.text === "(agent loop limit reached)") return "Deep research terminated (iteration limit reached).";
        return "Deep research completed, but no documents were produced.";
    }
    const compiled = docs.map(d => `# ${d.title}\n\n${d.content}`.trim()).join("\n\n");
    return `Deep Research Docs:\n\n${compiled}`;
}

interface AgentCallbacks {
    onFirstToken?: () => void,
    onToolCall?: (call: ToolCall, uniqueId: string) => void,
    onToolCallError?: (uniqueId: string, error: Error) => void,
    requestToolApproval?: (call: ToolCall, uniqueId: string) => Promise<{ approved: boolean; message?: string }>,
    onToolBatch?: (calls: ToolCall[], results: ToolResult[], sessionId: string) => Promise<void>,
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
    sessionId: string;
    messages: Message[];
    currentSystemPrompt: string = "";
    pendingFileSend: { path: string; caption: string } | null = null;
    isSubagent: boolean = false;
    private backgroundJobs = new Map<string, BackgroundSubagentJob>();

    constructor(sessionId: string, isSubagent?: boolean) {
        this.sessionId = sessionId;
        this.messages = [];
        if(isSubagent) {this.isSubagent = true;}
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
        return runDeepResearch(query, config, onSearchSummary, `${this.sessionId}-deepresearch-${Date.now()}`);
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
        const subSessionId = `${this.sessionId}-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        
        const subagent = new AgentSession(subSessionId, true);

        const contextMessages = includeContext ? this.messages.filter(x=>x.role=="user" || x.role=="assistant").slice(-24) : [];
        const contextBlock = includeContext && contextMessages.length > 0
            ? `\n\nParent context:\n${this.serializeMessagesForPrompt(contextMessages)}`
            : "";
        subagent.addMessage({
            role: "user",
            content: `Delegated request:\n${request}${contextBlock}`
        });

        const systemPrompt = (
            `${parentSystemPrompt}\n\n` +
            "You are operating as a subagent. Complete the delegated request and return only the final result."
        );
        
        const result = await subagent.evaluate(systemPrompt, config, {}, {tools: [defineTool(
            "dummy_tool",
            "This tool does nothing. As a subagent, you don't get access to any main agent tools.",
            {}, [],
            {handler: async ()=>{return ""}}
        )]});
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
        options?: { maxIterations?: number; tools?: ToolDefinition[] }
    ): Promise<{ text: string; reasoningSummary?: string; ranTools?: boolean }> {
        this.currentSystemPrompt = systemPrompt;
        const systemMessage: Message = { role: "system", content: systemPrompt };

        let firstTokenFired = false;
        const wrappedOnFirstToken = () => {
            if (!firstTokenFired) {
                firstTokenFired = true;
                if(callbacks.onFirstToken) {
                    callbacks.onFirstToken();
                }
            }
        };

        let didRunTools = false;
        const maxIterations = options?.maxIterations ?? 20;
        const agentTools = options?.tools ?? getTools(config);

        for (let iteration = 0; iteration < maxIterations; iteration++) {
            this.trimContextByChars();
            this.injectBackgroundResultsIntoContext();

            const result = await provider.generateCompletion(
                [systemMessage, ...this.messages],
                config,
                wrappedOnFirstToken,
                agentTools,
                this.sessionId
            );
            const { text, toolCalls, usage, reasoning_details } = result;

            if (usage) {
                await recordUsage(usage, getModelId(config));
            }

            if (toolCalls.length > 0) {
                didRunTools = true;
                this.messages.push({
                    role: "assistant",
                    content: text,
                    tool_calls: toolCalls,
                    ...(reasoning_details ? {reasoning_details} : {})
                });

                const toolResults: ToolResult[] = [];
                for (const tc of toolCalls) {
                    let toolResult: string;
                    const uniqueId = Math.random().toString(36).substring(2, 10);
                    try {
                        const name = tc.function.name;
                        const args = JSON.parse(tc.function.arguments);
                        if (callbacks.onToolCall) {
                            callbacks.onToolCall(tc, uniqueId);
                        }
                        const runTool = async () => {
                            if (callbacks.executeTool) {
                                const handled = await callbacks.executeTool(tc, args);
                                if (handled !== undefined) return handled;
                            }
                            
                            const tool = agentTools.filter(x=>x.schema.function.name == name)[0];

                            if(!tool) {
                                return `Unknown tool: ${name}`;
                            }
                            return await handleToolCallDefinition(tool, args, {
                                config,
                                session: this,
                                onDeepResearchSummary: callbacks.onDeepResearchSummary
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
    sessionId: string
): Promise<{ text: string; reasoningSummary?: string; ranTools?: boolean }> {
    const session = new AgentSession(sessionId);
    session.messages = [...history];
    return session.evaluate(systemPrompt, config, callbacks);
}

export type { Message, OpoclawConfig };
