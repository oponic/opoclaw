import type { OpoclawConfig } from "../config.ts";
import { generateCompletion } from "./openai.ts";
import type { Message, CompletionResult, ProviderFn } from "./types.ts";
import type { ToolDefinition } from "@/tools/types.ts";

export type { Message, ToolCall, CompletionResult, ProviderFn } from "./types.ts";

// A single OpenAI-compatible provider covers openrouter, ollama, and custom
// endpoints. There is no per-provider branching to unify — everything speaks
// the same wire format.
function defaultGenerateCompletion(
    messages: Message[],
    config: OpoclawConfig,
    onFirstToken: () => void,
    tools: ToolDefinition[],
    sessionId: string,
): Promise<CompletionResult> {
    return generateCompletion(messages, config, onFirstToken, tools.map((x) => x.schema), sessionId);
}

export const provider: { generateCompletion: ProviderFn } = {
    generateCompletion: defaultGenerateCompletion,
};
