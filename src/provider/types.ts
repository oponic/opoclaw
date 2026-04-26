import type { OpoclawConfig } from "../config.ts";

export interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: any | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    reasoning_details?: Record<string,string>[];
}

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface CompletionResult {
    text: string | null;
    toolCalls: ToolCall[];
    usage: any;
    reasoning: string;
    reasoning_details?: Record<string,string>[];
}

export type ProviderFn = (
    messages: Message[],
    config: OpoclawConfig,
    onFirstToken: () => void,
    toolsOverride: any[] | undefined,
    sessionId: string
) => Promise<CompletionResult>;
