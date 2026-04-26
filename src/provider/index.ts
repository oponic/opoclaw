import { getActiveProvider, type OpoclawConfig } from "../config.ts";
import { generateCompletion as openaiGenerate } from "./openai.ts";
import { generateCompletion as anthropicGenerate } from "./anthropic.ts";
import type { Message, CompletionResult, ProviderFn } from "./types.ts";

export type { Message, ToolCall, CompletionResult, ProviderFn } from "./types.ts";

function defaultGenerateCompletion(
    messages: Message[],
    config: OpoclawConfig,
    onFirstToken: () => void,
    toolsOverride: any[] | undefined,
    sessionId: string,
): Promise<CompletionResult> {
    if (getActiveProvider(config) === "custom" && config.provider?.custom?.api_type === "anthropic") {
        return anthropicGenerate(messages, config, onFirstToken, toolsOverride);
    }
    return openaiGenerate(messages, config, onFirstToken, toolsOverride, sessionId);
}

export const provider: { generateCompletion: ProviderFn } = {
    generateCompletion: defaultGenerateCompletion,
};
